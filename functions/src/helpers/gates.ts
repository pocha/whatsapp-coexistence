import { UNITS } from './rateLimiter';
import type { HealthView, Issue, Limits, NumberHealth, PhoneNumberDoc, Scope, Send, Why } from './types';

// What decides whether a send goes out, kept as small as possible: a number's `health` (the issues that
// restrict it, by scope and what they are), its `templates` in trouble, and Meta's daily limit. Everything
// here is pure, so the relay, the webhook and the dashboard use the same rules.

export const SCOPES: Scope[] = ['account', 'business', 'display_name', 'phone'];
const RANK: Record<Send, number> = { ok: 0, limit: 1, block: 2, disable: 3 };
const SEND = ['ok', 'limit', 'block', 'disable'] as const;
/** The daily number of customers a Meta messaging limit tier allows, e.g. TIER_250 -> 250. Undefined if unknown or unlimited. */
export function tierLimit(tier?: string): number | undefined {
  const match = /^TIER_(\d+)(K)?$/.exec(tier ?? '');
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : undefined;
}

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

/** The health with this issue set, replacing what the same scope and cause said before. Null if what is stored is newer. */
export function setIssue(health: NumberHealth | undefined, scope: Scope, why: Why, issue: Issue): NumberHealth | null {
  if ((health?.[scope]?.[why]?.at ?? 0) > issue.at) return null;
  return { ...health, [scope]: { ...health?.[scope], [why]: issue } };
}

/** The health without this issue, and only it: a lifted ban leaves a payment problem where it is. Null if there is nothing to clear, or it is newer. */
export function clearIssue(health: NumberHealth | undefined, scope: Scope, why: Why, at: number): NumberHealth | null {
  const existing = health?.[scope]?.[why];
  if (!health || !existing || existing.at > at) return null;
  const { [why]: _gone, ...rest } = health[scope]!;
  return { ...health, [scope]: rest };
}

/**
 * The result of a refresh replaces the stored issues, since it is Meta's whole picture now, except anything
 * learned after the read began (a notification that arrived while it ran).
 */
export function mergeRefresh(existing: NumberHealth | undefined, derived: NumberHealth, readStartedAt: number): NumberHealth {
  const merged: NumberHealth = { ...derived, tier: derived.tier ?? existing?.tier };
  for (const scope of SCOPES) {
    for (const [why, issue] of Object.entries(existing?.[scope] ?? {}) as [Why, Issue][]) {
      if (issue.at > readStartedAt && !merged[scope]?.[why]) merged[scope] = { ...merged[scope], [why]: issue };
    }
  }
  return merged;
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
