import { effectiveConfig, type RateLimitOverride } from './rateLimiter';
import { statusOf } from './gates';
import type { RateLimitConfig } from './rateLimitConfig';
import type { DisplayNameState, HealthReason, MetaSnapshot, NumberHealth, TemplateGate } from './types';

// Turns what Meta says about a number (its health_status and a few fields) into the one status we act on,
// and into the few things the user should be told. Kept simple on purpose, and hardcoded:
//   blocked  the account (WABA) or the number is BLOCKED
//   limited  the number itself is LIMITED, which for a new number means its display name is not approved yet
//   ok       anything else. A business that is LIMITED only because it is not verified is normal, so it is
//            shown as information on its own chip and changes nothing about what we let through.
// Each reason is written for the cases we know (what it means, what to do, where), and in Meta's own words
// for any other.

/** How long a spam-rate-limit refusal pauses a number's template sends. A guess: Meta gives no figure. */
export const COOLDOWN_MS = 60 * 60 * 1000;

/** Meta is not asked about a number again within this long of the last read. */
export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** The most template messages a limited number may send in a day. Our own cautious figure, not Meta's. */
export const LIMITED_DAILY_TEMPLATES = 5;

const WHATSAPP_MANAGER = 'https://business.facebook.com/latest/whatsapp_manager/';
const BUSINESS_SETTINGS = 'https://business.facebook.com/latest/settings';
const DISPLAY_NAME_GUIDELINES = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names';

/** The daily number of customers a Meta messaging limit tier allows, e.g. TIER_250 -> 250. Undefined if unknown or unlimited. */
export function tierLimit(tier?: string): number | undefined {
  const match = /^TIER_(\d+)(K)?$/.exec(tier ?? '');
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : undefined;
}

/**
 * The rate limits for a number: the usual ones, with the daily limit never above Meta's messaging limit tier
 * (250 while the business is unverified), and at most LIMITED_DAILY_TEMPLATES while the number is limited.
 * (Meta counts customers and we count template messages, so this is an approximation.)
 */
export function effectiveConfigFor(doc: { rateLimits?: RateLimitOverride; health?: NumberHealth }, now = Date.now()): RateLimitConfig {
  const base = effectiveConfig(doc.rateLimits);
  const limited = statusOf(doc.health?.reasons ?? [], now) === 'limited';
  const caps = [tierLimit(doc.health?.tier), limited ? LIMITED_DAILY_TEMPLATES : undefined, base.day.max].filter(
    (n): n is number => n !== undefined,
  );
  return caps.length ? { ...base, day: { ...base.day, max: Math.min(...caps) } } : base;
}

/** When Meta may be asked again about a number, an epoch time in ms (now, if it never was asked). */
export const nextRefreshAt = (metaFetchedAt: number | undefined, now: number) => (metaFetchedAt ? Math.max(now, metaFetchedAt + REFRESH_MIN_INTERVAL_MS) : now);

interface HealthEntity {
  entity_type?: string;
  can_send_message?: string;
  errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
  additional_info?: string[];
}

type Written = Pick<HealthReason, 'chip' | 'title' | 'message' | 'action' | 'link' | 'cause'>;

/** Copy for the Meta error codes we have seen. */
const KNOWN_CODES: Record<number, Written> = {
  141006: {
    chip: 'status',
    cause: 'payment',
    title: 'Payment method problem',
    message: "Meta can't use the account's payment method, so it blocks template (business-initiated) messages. Replies within 24 hours of a customer's message still go through.",
    action: "Open WhatsApp Manager, go to the account's payment settings and add or fix a payment method. Then refresh.",
    link: WHATSAPP_MANAGER,
  },
  141010: {
    chip: 'business',
    cause: 'business',
    title: 'Business unverified',
    message: "Your business hasn't passed Meta's business verification. Until it does, Meta caps you at 250 customers a day, and Watobot's daily limit stays under that. Everything else works.",
    action: 'Optional: to raise the cap, start business verification in Business Settings, under Security Center. Then refresh.',
    link: BUSINESS_SETTINGS,
  },
};

const isCalling = (code?: number, text?: string) => code === 138024 || code === 138025 || /\bSIP\b/.test(text ?? '');

const SCOPE_NAME: Record<string, string> = { WABA: 'account', PHONE_NUMBER: 'number', BUSINESS: 'business', APP: 'app' };

export interface DerivedHealth {
  health: NumberHealth;
  displayName: DisplayNameState;
}

/** The number's own `status` from Meta, as what it means for sending. These values are from memory of Meta's docs. */
const PHONE_STATUS: Record<string, Pick<HealthReason, 'cause' | 'severity' | 'title' | 'message' | 'action'>> = {
  BANNED: { cause: 'ban', severity: 'disabled', title: 'Number banned', message: 'Meta has banned this number, so nothing can be sent from it.', action: 'Open WhatsApp Manager and Business Support to see why and whether you can appeal.' },
  DELETED: { cause: 'ban', severity: 'disabled', title: 'Number deleted', message: 'This number has been deleted from the account.', action: 'Onboard it again if you still need it.' },
  DISCONNECTED: { cause: 'connection', severity: 'disabled', title: 'Number disconnected', message: 'The number is disconnected from the Cloud API, so nothing can be sent.', action: 'Register it again, or onboard it again.' },
  MIGRATED: { cause: 'connection', severity: 'disabled', title: 'Number moved', message: 'This number has been moved to another account.', action: 'Onboard it again here if you want it back.' },
  RESTRICTED: { cause: 'restriction', severity: 'blocked', title: 'Number restricted', message: 'Meta restricts this number, so template messages are refused.', action: 'Open WhatsApp Manager to see the restriction and what lifts it.' },
  FLAGGED: { cause: 'quality', severity: 'limited', title: 'Number flagged', message: 'Meta has flagged this number because of how its messages are received, and may lower its limits.', action: 'Pause campaigns and review your templates and who you message.' },
  RATE_LIMITED: { cause: 'quality', severity: 'limited', title: 'Number rate limited', message: 'Meta is limiting how much this number can send.', action: 'Slow down and wait before sending more.' },
};

/** The status from a live read, or null when the read didn't give one (the stored status is then left alone). */
export function deriveHealth(snapshot: Pick<MetaSnapshot, 'phone' | 'messagingLimit'> & Partial<Pick<MetaSnapshot, 'waba'>>, now: number): DerivedHealth | null {
  if (!snapshot.phone.ok) return null;
  const phone = snapshot.phone.data as Record<string, any>;
  if (!phone.health_status) return null;
  const entities: HealthEntity[] = phone.health_status.entities ?? [];

  const reasons: HealthReason[] = [];
  const add = (reason: Omit<HealthReason, 'at'>) => {
    if (!reasons.some((r) => r.chip === reason.chip && r.title === reason.title)) reasons.push({ ...reason, at: now });
  };

  let businessVerified: boolean | undefined;
  for (const entity of entities) {
    const state = entity.can_send_message;
    if (!state || state === 'AVAILABLE') continue;
    const scope = entity.entity_type ?? 'UNKNOWN';
    const severity: HealthReason['severity'] =
      state === 'BLOCKED' && (scope === 'WABA' || scope === 'PHONE_NUMBER')
        ? 'blocked'
        : state === 'LIMITED' && scope === 'PHONE_NUMBER'
          ? 'limited'
          : 'info';

    for (const error of entity.errors ?? []) {
      if (isCalling(error.error_code, error.error_description)) continue;
      const known = error.error_code ? KNOWN_CODES[error.error_code] : undefined;
      if (error.error_code === 141010) businessVerified = false;
      add({
        ...(known ?? {
          chip: 'status' as const,
          cause: 'meta' as const,
          title: `Meta flagged the ${SCOPE_NAME[scope] ?? 'account'}`,
          message: error.error_description ?? 'Meta gave no description.',
          action: error.possible_solution ?? 'Check WhatsApp Manager for details, fix what it names, then refresh.',
          link: WHATSAPP_MANAGER,
        }),
        scope,
        severity: known?.chip === 'business' ? 'info' : severity,
        code: error.error_code,
      });
    }
    for (const info of entity.additional_info ?? []) {
      if (/display name/i.test(info)) {
        add({
          chip: 'name',
          cause: 'name',
          title: 'Display name not approved yet',
          message: `${info} Until it is approved the number can send only a few template messages a day (Watobot allows ${LIMITED_DAILY_TEMPLATES}). Replies in a chat are not limited.`,
          action: "Wait for Meta's decision. If you haven't requested a name, or it was declined, request one that follows the guidelines.",
          link: DISPLAY_NAME_GUIDELINES,
          scope,
          severity,
        });
      } else {
        add({ chip: 'status', cause: 'meta', title: 'A note from Meta', message: info, action: 'Check WhatsApp Manager if this affects you, then refresh.', link: WHATSAPP_MANAGER, scope, severity: 'info' });
      }
    }
    // Blocked or limited with no reason Meta gave: say so, so the status is never unexplained.
    if (severity !== 'info' && !reasons.some((r) => r.scope === scope && r.severity === severity)) {
      add({
        chip: 'status',
        cause: severity === 'limited' ? 'limited' : 'meta',
        title: severity === 'blocked' ? 'Meta says this number is blocked' : 'Meta says this number is limited',
        message: 'Meta gave no reason.',
        action: 'Check WhatsApp Manager, fix what it names, then refresh.',
        link: WHATSAPP_MANAGER,
        scope,
        severity,
      });
    }
  }

  // The number's own status, and the account's review.
  const byStatus = PHONE_STATUS[String(phone.status ?? '')];
  if (byStatus) add({ ...byStatus, chip: 'status', link: WHATSAPP_MANAGER, scope: 'PHONE_NUMBER' });
  const waba = snapshot.waba?.ok ? (snapshot.waba.data as Record<string, any>) : undefined;
  const review = String(waba?.account_review_status ?? '');
  if (review && review !== 'APPROVED') {
    add({
      chip: 'status',
      cause: 'review',
      severity: 'disabled',
      title: `Account review: ${review.toLowerCase()}`,
      message: `Meta's review of the account is ${review.toLowerCase()}, and until it is approved the account cannot be used with the API.`,
      action: 'Open WhatsApp Manager and Business Support to see what Meta needs.',
      link: WHATSAPP_MANAGER,
      scope: 'WABA',
    });
  }
  if (typeof waba?.business_verification_status === 'string') businessVerified = waba.business_verification_status === 'verified';

  // A name change that is in review or was declined needs the user too, even when sending is not held back.
  const requested = String(phone.new_name_status ?? '');
  if (/PENDING/i.test(requested)) {
    add({
      chip: 'name',
      cause: 'name',
      title: 'Display name in review',
      message: `Meta is reviewing the name "${phone.new_display_name ?? 'you requested'}".`,
      action: "Wait for Meta's decision. Don't submit another name until it arrives.",
      link: DISPLAY_NAME_GUIDELINES,
      scope: 'PHONE_NUMBER',
      severity: 'info',
    });
  } else if (/DECLINED/i.test(requested) || /DECLINED/i.test(String(phone.name_status ?? ''))) {
    add({
      chip: 'name',
      cause: 'name',
      title: 'Display name declined',
      message: 'Meta declined the display name.',
      action: 'Request a different name that follows the guidelines.',
      link: DISPLAY_NAME_GUIDELINES,
      scope: 'PHONE_NUMBER',
      severity: 'info',
    });
  }

  if (/RED|YELLOW/i.test(String(phone.quality_rating ?? ''))) {
    add({
      chip: 'status',
      cause: 'quality',
      title: 'Message quality is low',
      message: 'Customers are blocking or reporting your messages more than Meta likes. If it stays low, Meta lowers your limit or blocks the number.',
      action: 'Pause campaigns, send only to people who asked to hear from you, and review your templates. Then refresh.',
      link: WHATSAPP_MANAGER,
      scope: 'PHONE_NUMBER',
      // Red counts as limited (few template messages a day); yellow is a warning.
      severity: /RED/i.test(String(phone.quality_rating)) ? 'limited' : 'info',
    });
  }

  const tier = snapshot.messagingLimit.ok && typeof snapshot.messagingLimit.data === 'string' ? snapshot.messagingLimit.data : undefined;
  const displayName: DisplayNameState = {
    at: now,
    name: phone.verified_name,
    status: phone.name_status,
    requestedName: phone.new_display_name,
    requestedStatus: phone.new_name_status,
  };
  return { health: { status: statusOf(reasons, now), reasons, ...(tier ? { tier } : {}), ...(businessVerified !== undefined ? { businessVerified } : {}) }, displayName };
}

/** What a refused send tells us about the number, from Meta's error code. */
export function reasonsFromRefusal(error: { code?: number; message?: string } | undefined, now: number): HealthReason[] {
  const detail = error?.message ?? 'Meta refused the send.';
  switch (error?.code) {
    case 131042:
      return [{ ...KNOWN_CODES[141006], scope: 'MESSAGE', severity: 'blocked', code: 131042, at: now, message: `Meta refused a send because of the account's payment method (${detail}). Template messages are blocked until it is fixed; replies still go through.` }];
    case 131031:
      return [{ chip: 'status', cause: 'ban', scope: 'MESSAGE', severity: 'disabled', code: 131031, at: now, title: 'Account locked', message: `Meta refused a send because the account is locked (${detail}).`, action: 'Open WhatsApp Manager and Business Support to see why, then refresh.', link: WHATSAPP_MANAGER }];
    case 131048:
      return [{
        chip: 'status', cause: 'cooldown', scope: 'MESSAGE', severity: 'blocked', code: 131048, at: now, until: now + COOLDOWN_MS,
        title: 'Template messages paused',
        message: `Meta says this number is sending more than recipients want (a spam rate limit, ${detail}). Watobot pauses its template messages for an hour so that more sends do not make it worse. Replies still go through.`,
        action: 'Cut how many template messages you send, send only to people who asked for them, and review your templates.',
        link: WHATSAPP_MANAGER,
      }];
    default:
      return [];
  }
}

/** A refused send that names a template Meta has paused or disabled, as that template's entry. */
export function templateGateFromRefusal(error: { code?: number; message?: string } | undefined, templateKey: string | undefined, now: number): { key: string; gate: TemplateGate } | null {
  const status = error?.code === 132015 ? 'PAUSED' : error?.code === 132016 ? 'DISABLED' : undefined;
  return status && templateKey ? { key: templateKey, gate: { status, reason: error?.message, at: now } } : null;
}
