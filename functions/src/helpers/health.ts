import type { DisplayNameState, HealthReason, MetaSnapshot, NumberHealth } from './types';

// Turns what Meta says about a number (its health_status) into the one status we act on. Kept simple on
// purpose, and hardcoded:
//   blocked  the account (WABA) or the number is BLOCKED
//   limited  the number itself is LIMITED, which for a new number means its display name is not approved
//   ok       anything else. A business that is LIMITED only because it is not verified is normal (its
//            messaging limit tier still applies), so it is shown as information and changes nothing.

/** Calling (SIP) problems have nothing to do with sending messages. */
const isCalling = (code?: number, text?: string) => code === 138024 || code === 138025 || /\bSIP\b/.test(text ?? '');

interface HealthEntity {
  entity_type?: string;
  can_send_message?: string;
  errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
  additional_info?: string[];
}

export interface DerivedHealth {
  health: NumberHealth;
  displayName: DisplayNameState;
}

/** The status from a live read, or null when the read didn't give one (the stored status is then left alone). */
export function deriveHealth(snapshot: Pick<MetaSnapshot, 'phone'>, now: number): DerivedHealth | null {
  if (!snapshot.phone.ok) return null;
  const phone = snapshot.phone.data as Record<string, any>;
  const entities: HealthEntity[] = phone.health_status?.entities ?? [];
  if (!phone.health_status) return null;

  const reasons: HealthReason[] = [];
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
      reasons.push({ scope, severity, code: error.error_code, message: error.error_description ?? 'Meta gave no description.', fix: error.possible_solution });
    }
    for (const info of entity.additional_info ?? []) reasons.push({ scope, severity, message: info });
  }
  const displayName: DisplayNameState = {
    name: phone.verified_name,
    status: phone.name_status,
    requestedName: phone.new_display_name,
    requestedStatus: phone.new_name_status,
  };
  return { health: { status, reasons, checkedAt: now, source: 'meta' }, displayName };
}

/** Meta's error codes for a send that says the account cannot send business-initiated messages at all. */
const BLOCKING_CODES: Record<number, string> = {
  131042: 'Meta refused the send: there is a problem with the account\'s payment method.',
  131031: 'Meta refused the send: the account has been locked.',
};

/** A Meta refusal that means the number is blocked, as a status; null for any other refusal. */
export function healthFromRefusal(error: { code?: number; message?: string } | undefined, now: number): NumberHealth | null {
  if (!error?.code || !(error.code in BLOCKING_CODES)) return null;
  return {
    status: 'blocked',
    checkedAt: now,
    source: 'refusal',
    reasons: [{ scope: 'MESSAGE', severity: 'blocked', code: error.code, message: BLOCKING_CODES[error.code], fix: error.message }],
  };
}

/** The most template messages a limited number may send in a day. Our own cautious figure, not Meta's. */
export const LIMITED_DAILY_TEMPLATES = 5;
