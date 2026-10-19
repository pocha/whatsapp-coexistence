import type { GateCause, HealthReason, NumberHealth, PhoneNumberDoc } from './types';

// What decides whether a send goes out, kept as small as possible: a number's `health` (a list of reasons, each
// with the cause that raised it, and a status worked out from them), its `templates` in trouble, and the tier.
// Everything here is pure, so the relay, the webhook and the dashboard use the same rules.

const RANK = { info: 0, limited: 1, blocked: 2, disabled: 3 } as const;
const STATUS = ['ok', 'limited', 'blocked', 'disabled'] as const;

/** A reason with an end time stops counting by itself once that has passed. */
export const counts = (reason: HealthReason, now: number) => reason.until === undefined || reason.until > now;

/** The worst thing that currently counts. */
export function statusOf(reasons: HealthReason[], now: number): NumberHealth['status'] {
  let top = 0;
  for (const reason of reasons) if (counts(reason, now)) top = Math.max(top, RANK[reason.severity]);
  return STATUS[top];
}

/** `base` with these reasons, and the status they add up to. */
export function settle(base: Partial<NumberHealth> | undefined, reasons: HealthReason[], now: number): NumberHealth {
  return { ...base, reasons, status: statusOf(reasons, now) };
}

/**
 * Sets what one cause says, replacing what that cause said before. Returns null when nothing should change:
 * what is stored about that cause was learned later than this, so an old notification arriving late is ignored.
 */
export function raise(health: NumberHealth | undefined, reason: HealthReason, now: number): NumberHealth | null {
  const same = (health?.reasons ?? []).filter((r) => r.cause === reason.cause);
  if (same.some((r) => r.at > reason.at)) return null;
  return settle(health, [...(health?.reasons ?? []).filter((r) => r.cause !== reason.cause), reason], now);
}

/** Clears what one cause said, and only that one: a lifted ban leaves a payment problem where it is. Null if there is nothing to clear, or it is newer. */
export function clear(health: NumberHealth | undefined, cause: GateCause, at: number, now: number): NumberHealth | null {
  const same = (health?.reasons ?? []).filter((r) => r.cause === cause);
  if (!health || !same.length || same.some((r) => r.at > at)) return null;
  return settle(health, health.reasons.filter((r) => r.cause !== cause), now);
}

/**
 * The result of a refresh replaces the stored reasons, since it is Meta's whole picture now, except anything
 * learned after the read began (a notification that arrived while it ran).
 */
export function mergeRefresh(existing: NumberHealth | undefined, derived: NumberHealth, readStartedAt: number, now: number): NumberHealth {
  const newer = (existing?.reasons ?? []).filter((r) => r.at > readStartedAt && !derived.reasons.some((d) => d.cause === r.cause));
  return settle({ tier: derived.tier ?? existing?.tier, businessVerified: derived.businessVerified ?? existing?.businessVerified }, [...derived.reasons, ...newer], now);
}

export type SendDecision =
  | { allow: true }
  | { allow: false; httpStatus: 403 | 429; error: string; status: NumberHealth['status'] | 'template'; reasons: HealthReason[]; retryAfterSeconds?: number };

/** The key a send names its template by. */
export const templateKey = (message: any): string | undefined =>
  message?.template?.name ? templateKeyOf(message.template.name, message.template.language?.code) : undefined;

/** `name|language`, with the language written the way sends write it (en_US), since Meta's webhooks write en-US. */
export const templateKeyOf = (name: string, language?: string) => `${name}|${String(language ?? '').replace('-', '_')}`;

/**
 * Whether a message may go out, from what is stored. A disabled number sends nothing; a blocked one sends no
 * template messages (replies in a chat still go); a template Meta paused or disabled is refused. A limited
 * number's cap is applied where the rate limit is (see effectiveConfigFor).
 */
export function sendDecision(doc: Pick<PhoneNumberDoc, 'health' | 'templates'>, message: any, now: number): SendDecision {
  const active = (doc.health?.reasons ?? []).filter((r) => counts(r, now));
  const status = statusOf(active, now);
  const worst = (severity: HealthReason['severity']) => active.filter((r) => r.severity === severity);

  if (status === 'disabled') {
    return { allow: false, httpStatus: 403, status, reasons: worst('disabled'), error: 'This number cannot send messages right now. See the reasons below, fix them, then refresh the number (the dashboard, or get_number with refresh).' };
  }
  if (message?.type !== 'template') return { allow: true };

  if (status === 'blocked') {
    const blocking = worst('blocked');
    const untils = blocking.map((r) => r.until);
    const temporary = untils.every((u) => u !== undefined);
    const retryAfterSeconds = temporary ? Math.max(1, Math.ceil((Math.max(...(untils as number[])) - now) / 1000)) : undefined;
    return {
      allow: false,
      httpStatus: temporary ? 429 : 403,
      status,
      reasons: blocking,
      retryAfterSeconds,
      error: temporary
        ? 'Template messages from this number are paused for a while. Free-form replies still go through. See the reasons below.'
        : 'This number is blocked from sending template messages. Free-form replies still go through. Fix the reasons below, then refresh the number (the dashboard, or get_number with refresh) to lift this.',
    };
  }

  const key = templateKey(message);
  const gate = key ? doc.templates?.[key] : undefined;
  if (gate) {
    const [name, language] = key!.split('|');
    return {
      allow: false,
      httpStatus: 403,
      status: 'template',
      reasons: [],
      error: `Meta has ${gate.status.toLowerCase()} the template "${name}" (${language}), so it is not sent.${gate.reason ? ` Reason: ${gate.reason}.` : ''} Other templates are not affected. Fix it in WhatsApp Manager (Message templates).`,
    };
  }
  return { allow: true };
}
