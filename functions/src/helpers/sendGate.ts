import { UNITS } from './rateLimiter';
import type { HealthView, Issue, Limits, NumberHealth, PhoneNumberDoc, Scope, Send, Why } from './types';

// Reading a number's `health` (the issues that restrict it, by scope and what they are), its `templates` in
// trouble and Meta's daily limit, to say whether a send goes out. Nothing here changes the health; that is
// done by the webhook rows (rules.ts) and the refresh (health.ts). Everything here is pure, so the relay and
// the dashboard use the same rules.

export const SCOPES: Scope[] = ['account', 'business', 'display_name', 'phone'];
const RANK: Record<Send, number> = { ok: 0, limit: 1, block: 2, disable: 3 };
const SEND = ['ok', 'limit', 'block', 'disable'] as const;
export type Active = Issue & { scope: Scope; why: Why };

/** An issue with an end time stops counting by itself once that has passed. */
export const counts = (issue: Issue, now: number) => issue.until === undefined || issue.until > now;

/** Every issue that counts now. */
export function activeIssues(health: NumberHealth | undefined, now: number): Active[] {
  return SCOPES.flatMap((scope) => Object.entries(health?.[scope] ?? {}).map(([why, issue]) => ({ ...(issue as Issue), scope, why: why as Why }))).filter((i) => counts(i, now));
}

const worst = (issues: Pick<Issue, 'send'>[]): Send => SEND[Math.max(0, ...issues.map((i) => RANK[i.send]))];

/** The lowest ceiling per window across Meta's daily limit and what the issues allow. */
export function capsOf(health: NumberHealth | undefined, now: number): Limits {
  const caps: Limits = health?.tier ? { day: health.tier } : {};
  for (const issue of activeIssues(health, now)) {
    for (const unit of UNITS) {
      const cap = issue.cap?.[unit];
      if (cap !== undefined) caps[unit] = Math.min(caps[unit] ?? Infinity, cap);
    }
  }
  return caps;
}

/** The health as callers see it now: each scope's status, the worst of them, and the ceilings. */
export function presentHealth(health: NumberHealth, now: number): HealthView {
  const issues = activeIssues(health, now);
  const scopes: HealthView['scopes'] = {};
  for (const scope of SCOPES) {
    const own = issues.filter((i) => i.scope === scope);
    if (own.length) scopes[scope] = { status: worst(own), issues: own.map(({ scope: _s, ...rest }) => rest) };
  }
  return { status: worst(issues), scopes, limits: capsOf(health, now) };
}

export type SendDecision =
  | { allow: true }
  | { allow: false; httpStatus: 403 | 429; error: string; status: Send | 'template'; issues: Active[]; retryAfterSeconds?: number };

/** The key a send names its template by. */
export const templateKey = (message: any): string | undefined =>
  message?.template?.name ? templateKeyOf(message.template.name, message.template.language?.code) : undefined;

/** `name|language`, with the language written the way sends write it (en_US), since Meta's webhooks write en-US. */
export const templateKeyOf = (name: string, language?: string) => `${name}|${String(language ?? '').replace('-', '_')}`;

/**
 * Whether a message may go out, from what is stored. A disabled number sends nothing; a blocked one sends no
 * template messages (replies in a chat still go); a template Meta paused or disabled is refused. A limited
 * number's ceilings are applied where the rate limit is (see effectiveConfigFor).
 */
export function sendDecision(doc: Pick<PhoneNumberDoc, 'health' | 'templates'>, message: any, now: number): SendDecision {
  const issues = activeIssues(doc.health, now);
  const status = worst(issues);
  const with_ = (send: Send) => issues.filter((i) => i.send === send);

  if (status === 'disable') {
    return { allow: false, httpStatus: 403, status, issues: with_('disable'), error: 'This number cannot send messages right now. See the issues below, fix them, then refresh the number (the dashboard, or get_number with refresh).' };
  }
  if (message?.type !== 'template') return { allow: true };

  if (status === 'block') {
    const blocking = with_('block');
    const temporary = blocking.every((i) => i.until !== undefined);
    const retryAfterSeconds = temporary ? Math.max(1, Math.ceil((Math.max(...blocking.map((i) => i.until!)) - now) / 1000)) : undefined;
    return {
      allow: false,
      httpStatus: temporary ? 429 : 403,
      status,
      issues: blocking,
      retryAfterSeconds,
      error: temporary
        ? 'Template messages from this number are paused for a while. Free-form replies still go through. See the issues below.'
        : 'This number is blocked from sending template messages. Free-form replies still go through. Fix the issues below, then refresh the number (the dashboard, or get_number with refresh) to lift this.',
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
      issues: [],
      error: `Meta has ${gate.status.toLowerCase()} the template "${name}" (${language}), so it is not sent.${gate.reason ? ` Reason: ${gate.reason}.` : ''} Other templates are not affected. Fix it in WhatsApp Manager (Message templates).`,
    };
  }
  return { allow: true };
}
