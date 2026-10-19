import { effectiveConfig, type RateLimitOverride } from './rateLimiter';
import type { RateLimitConfig } from './rateLimitConfig';
import type { DisplayNameState, HealthReason, MetaSnapshot, NumberHealth } from './types';

// Turns what Meta says about a number (its health_status and a few fields) into the one status we act on,
// and into the few things the user should be told. Kept simple on purpose, and hardcoded:
//   blocked  the account (WABA) or the number is BLOCKED
//   limited  the number itself is LIMITED, which for a new number means its display name is not approved yet
//   ok       anything else. A business that is LIMITED only because it is not verified is normal, so it is
//            shown as information on its own chip and changes nothing about what we let through.
// Each reason is written for the cases we know (what it means, what to do, where), and in Meta's own words
// for any other.

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
export function effectiveConfigFor(doc: { rateLimits?: RateLimitOverride; health?: NumberHealth }): RateLimitConfig {
  const base = effectiveConfig(doc.rateLimits);
  const caps = [tierLimit(doc.health?.tier), doc.health?.status === 'limited' ? LIMITED_DAILY_TEMPLATES : undefined, base.day.max].filter(
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

type Written = Pick<HealthReason, 'chip' | 'title' | 'message' | 'action' | 'link'>;

/** Copy for the Meta error codes we have seen. */
const KNOWN_CODES: Record<number, Written> = {
  141006: {
    chip: 'status',
    title: 'Payment method problem',
    message: "Meta can't use the account's payment method, so it blocks template (business-initiated) messages. Replies within 24 hours of a customer's message still go through.",
    action: "Open WhatsApp Manager, go to the account's payment settings and add or fix a payment method. Then refresh.",
    link: WHATSAPP_MANAGER,
  },
  141010: {
    chip: 'business',
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

/** The status from a live read, or null when the read didn't give one (the stored status is then left alone). */
export function deriveHealth(snapshot: Pick<MetaSnapshot, 'phone' | 'messagingLimit'>): DerivedHealth | null {
  if (!snapshot.phone.ok) return null;
  const phone = snapshot.phone.data as Record<string, any>;
  if (!phone.health_status) return null;
  const entities: HealthEntity[] = phone.health_status.entities ?? [];

  const reasons: HealthReason[] = [];
  const add = (reason: HealthReason) => {
    if (!reasons.some((r) => r.chip === reason.chip && r.title === reason.title)) reasons.push(reason);
  };

  let status: NumberHealth['status'] = 'ok';
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
    if (severity === 'blocked') status = 'blocked';
    else if (severity === 'limited' && status !== 'blocked') status = 'limited';

    for (const error of entity.errors ?? []) {
      if (isCalling(error.error_code, error.error_description)) continue;
      const known = error.error_code ? KNOWN_CODES[error.error_code] : undefined;
      add({
        ...(known ?? {
          chip: 'status' as const,
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
          title: 'Display name not approved yet',
          message: `${info} Until it is approved the number can send only a few template messages a day (Watobot allows ${LIMITED_DAILY_TEMPLATES}). Replies in a chat are not limited.`,
          action: "Wait for Meta's decision. If you haven't requested a name, or it was declined, request one that follows the guidelines.",
          link: DISPLAY_NAME_GUIDELINES,
          scope,
          severity,
        });
      } else {
        add({ chip: 'status', title: 'A note from Meta', message: info, action: 'Check WhatsApp Manager if this affects you, then refresh.', link: WHATSAPP_MANAGER, scope, severity: 'info' });
      }
    }
  }

  // A name change that is in review or was declined needs the user too, even when sending is not held back.
  const requested = String(phone.new_name_status ?? '');
  if (/PENDING/i.test(requested)) {
    add({
      chip: 'name',
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
      title: 'Message quality is low',
      message: 'Customers are blocking or reporting your messages more than Meta likes. If it stays low, Meta lowers your limit or blocks the number.',
      action: 'Pause campaigns, send only to people who asked to hear from you, and review your templates. Then refresh.',
      link: WHATSAPP_MANAGER,
      scope: 'PHONE_NUMBER',
      severity: 'info',
    });
  }

  if (status !== 'ok' && !reasons.some((r) => r.severity === status)) {
    add({
      chip: 'status',
      title: status === 'blocked' ? 'Meta says this number is blocked' : 'Meta says this number is limited',
      message: 'Meta gave no reason.',
      action: 'Check WhatsApp Manager, fix what it names, then refresh.',
      link: WHATSAPP_MANAGER,
      scope: 'PHONE_NUMBER',
      severity: status,
    });
  }

  const tier = snapshot.messagingLimit.ok && typeof snapshot.messagingLimit.data === 'string' ? snapshot.messagingLimit.data : undefined;
  const displayName: DisplayNameState = {
    name: phone.verified_name,
    status: phone.name_status,
    requestedName: phone.new_display_name,
    requestedStatus: phone.new_name_status,
  };
  return { health: { status, reasons, ...(tier ? { tier } : {}) }, displayName };
}

/** Meta's error codes for a send that says the account cannot send business-initiated messages at all. */
const BLOCKING_CODES: Record<number, string> = { 131042: 'payment', 131031: 'locked' };

/** A Meta refusal that means the number is blocked, as a status; null for any other refusal. */
export function healthFromRefusal(error: { code?: number; message?: string } | undefined): NumberHealth | null {
  if (!error?.code || !(error.code in BLOCKING_CODES)) return null;
  const payment = error.code === 131042;
  return {
    status: 'blocked',
    reasons: [
      {
        chip: 'status',
        scope: 'MESSAGE',
        severity: 'blocked',
        code: error.code,
        title: payment ? 'Meta refused a send: payment method' : 'Meta refused a send: account locked',
        message: error.message ?? 'Meta refused the send.',
        action: payment ? "Open WhatsApp Manager, fix the account's payment method, then refresh." : 'Check WhatsApp Manager and Business Support for why the account is locked, then refresh.',
        link: WHATSAPP_MANAGER,
      },
    ],
  };
}
