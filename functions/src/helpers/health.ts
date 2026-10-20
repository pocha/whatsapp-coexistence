import { tierLimit } from './gates';
import { issueFrom } from './gateEvents';
import { LINKS, RULES } from './rules';
import type { DisplayNameState, Issue, MetaSnapshot, NumberHealth, Scope, TemplateGate, Why } from './types';

// Turns what Meta says about a number (its health_status and a few fields) into the issues we act on. The
// wording is in the rows of rules.ts. A known Meta error code, the number's status, the account review and a
// red quality rating each have a row; any other error Meta gives is stored in Meta's own words.

/** Meta is not asked about a number again within this long of the last read. */
export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** When Meta may be asked again about a number, an epoch time in ms (now, if it never was asked). */
export const nextRefreshAt = (metaFetchedAt: number | undefined, now: number) => (metaFetchedAt ? Math.max(now, metaFetchedAt + REFRESH_MIN_INTERVAL_MS) : now);

interface HealthEntity {
  entity_type?: string;
  can_send_message?: string;
  errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
  additional_info?: string[];
}

const isCalling = (code?: number, text?: string) => code === 138024 || code === 138025 || /\bSIP\b/.test(text ?? '');

const SCOPE_OF: Record<string, Scope> = { WABA: 'account', PHONE_NUMBER: 'phone', BUSINESS: 'business' };
const SCOPE_NAME: Record<Scope, string> = { account: 'account', phone: 'number', business: 'business', display_name: 'display name' };

export interface DerivedHealth {
  health: NumberHealth;
  displayName: DisplayNameState;
}

export function deriveHealth(snapshot: Pick<MetaSnapshot, 'phone' | 'messagingLimit'> & Partial<Pick<MetaSnapshot, 'waba'>>, now: number): DerivedHealth | null {
  if (!snapshot.phone.ok) return null;
  const phone = snapshot.phone.data as Record<string, any>;
  if (!phone.health_status) return null;

  const health: NumberHealth = {};
  const add = (scope: Scope, why: Why, issue: Issue) => {
    health[scope] = { ...health[scope], [why]: issue };
  };
  /** Adds the issue a row stands for. False when there is no such row. */
  const fromRow = (key: string, ctx: Record<string, unknown> = {}) => {
    const rule = RULES[key];
    if (!rule?.scope || !rule.why || !rule.send) return false;
    add(rule.scope, rule.why, issueFrom({ ...rule, send: rule.send }, ctx, now));
    return true;
  };

  for (const entity of (phone.health_status.entities ?? []) as HealthEntity[]) {
    const state = entity.can_send_message;
    const scope = SCOPE_OF[entity.entity_type ?? ''];
    if (!state || state === 'AVAILABLE' || !scope) continue;
    // Only these restrict sending; a business that is LIMITED only because it is unverified is normal (its own row).
    const send = state === 'BLOCKED' && scope !== 'business' ? 'block' : state === 'LIMITED' && scope === 'phone' ? 'limit' : undefined;
    let explained = false;

    for (const error of entity.errors ?? []) {
      if (isCalling(error.error_code, error.error_description)) continue;
      if (fromRow(`code:${error.error_code}`)) explained = true;
      else if (send && error.error_code) {
        add(scope, `code_${error.error_code}`, {
          send,
          title: `Meta flagged the ${SCOPE_NAME[scope]}`,
          message: `${error.error_description ?? 'Meta gave no description.'} ${error.possible_solution ?? 'Check WhatsApp Manager for details, fix what it names, then refresh.'}`,
          link: LINKS.manager,
          at: now,
          code: error.error_code,
          ...(send === 'limit' ? { cap: RULES['phone_status:FLAGGED'].cap } : {}),
        });
        explained = true;
      }
    }
    for (const note of entity.additional_info ?? []) if (/display name/i.test(note) && fromRow('phone_note:display_name', { note })) explained = true;

    // Blocked or limited with no reason Meta gave: say so, so the status is never unexplained.
    if (send && !explained) {
      add(scope, 'meta', {
        send,
        title: `Meta says this ${SCOPE_NAME[scope]} is ${send === 'block' ? 'blocked' : 'limited'}`,
        message: 'Meta gave no reason. Check WhatsApp Manager, fix what it names, then refresh.',
        link: LINKS.manager,
        at: now,
        ...(send === 'limit' ? { cap: RULES['phone_status:FLAGGED'].cap } : {}),
      });
    }
  }

  // The number's own status, the account's review and the quality rating.
  fromRow(`phone_status:${phone.status}`);
  const waba = snapshot.waba?.ok ? (snapshot.waba.data as Record<string, any>) : undefined;
  const review = String(waba?.account_review_status ?? '');
  if (review && review !== 'APPROVED') fromRow('review', { status: review });
  if (/RED/i.test(String(phone.quality_rating ?? ''))) fromRow('quality:RED');

  // Meta's daily messaging limit.
  const tierName = snapshot.messagingLimit.ok && typeof snapshot.messagingLimit.data === 'string' ? snapshot.messagingLimit.data : undefined;
  const tier = tierLimit(tierName);
  if (tier) health.tier = tier;

  const displayName: DisplayNameState = {
    at: now,
    name: phone.verified_name,
    status: phone.name_status,
    requestedName: phone.new_display_name,
    requestedStatus: phone.new_name_status,
  };
  return { health, displayName };
}

/** What a refused send tells us about the number, from Meta's error code. */
export function issuesFromRefusal(error: { code?: number; message?: string } | undefined, now: number): { scope: Scope; why: Why; issue: Issue }[] {
  const rule = RULES[`refusal:${error?.code}`];
  if (!rule?.scope || !rule.why || !rule.send) return [];
  return [{ scope: rule.scope, why: rule.why, issue: { ...issueFrom({ ...rule, send: rule.send }, { detail: error?.message ?? 'Meta refused the send.' }, now), code: error?.code } }];
}

/** A refused send that names a template Meta has paused or disabled, as that template's entry. */
export function templateGateFromRefusal(error: { code?: number; message?: string } | undefined, templateKey: string | undefined, now: number): { key: string; gate: TemplateGate } | null {
  const status = error?.code === 132015 ? 'PAUSED' : error?.code === 132016 ? 'DISABLED' : undefined;
  return status && templateKey ? { key: templateKey, gate: { status, reason: error?.message, at: now } } : null;
}
