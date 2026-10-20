import { clearIssue, setIssue, templateKeyOf } from './gates';
import { ALIASES, LINKS, NEVER_KEPT, PICK, RULES, type Rule } from './rules';
import type { DisplayNameState, Issue, NotificationDoc, PhoneNumberDoc, Scope, TemplateGate, Why } from './types';

// What Meta's webhooks tell us about a number's account, in two steps: parseWebhook turns a payload into
// events (what to show in the Notifications, and what the event does to the gates) using the rows in
// rules.ts, and applyEffects applies those to a number's record. Both are pure. Only account-level
// fields are handled; a `messages` event, a history or contacts sync or an echo is never looked at, let alone kept.

export type Effect =
  | { kind: 'set'; scope: Scope; why: Why; issue: Issue }
  | { kind: 'clear'; scope: Scope; why: Why }
  /** Meta's daily messaging limit; null when there is none. */
  | { kind: 'tier'; tier: number | null }
  | { kind: 'name'; patch: Partial<DisplayNameState> }
  | { kind: 'template'; key: string; gate: TemplateGate | null };

export interface WebhookEvent {
  wabaId: string;
  eventAt: number;
  field: string;
  event?: string;
  /** The number's display phone number, for the events that are about one number. */
  displayPhone?: string;
  notification: Pick<NotificationDoc, 'title' | 'message' | 'severity'>;
  effects: Effect[];
  value: unknown;
}

const label = (text: string) => text.toLowerCase().replace(/_/g, ' ');

/** Fills a row's text from the payload and the values its source picked. See rules.ts for the syntax. */
export function fill(text: string, ctx: Record<string, any>): string {
  const render = (part: string) => {
    let missing = false;
    const out = part.replace(/\{\{([\w.]+)(?:\|(label))?\}\}/g, (_, path: string, filter?: string) => {
      let v: any = path.split('.').reduce((o: any, k) => o?.[k], ctx);
      if (Array.isArray(v)) v = v.join(', ');
      if (v === undefined || v === null || v === '') {
        missing = true;
        return '';
      }
      return filter ? label(String(v)) : String(v);
    });
    return { out, missing };
  };
  return render(text.replace(/\[([^[\]]*)\]/g, (_, inner: string) => { const r = render(inner); return r.missing ? '' : r.out; })).out;
}

/** The row for a signal, following the aliases. */
export const ruleFor = (key: string): Rule | undefined => RULES[ALIASES[key] ?? key];

/** The issue a row stands for, learned at `at`. */
export function issueFrom(rule: Rule & { send: NonNullable<Rule['send']> }, ctx: Record<string, any>, at: number): Issue {
  return {
    send: rule.send,
    title: fill(rule.title, ctx),
    message: fill(rule.message, ctx),
    ...(rule.link ? { link: LINKS[rule.link] } : {}),
    at,
    ...(rule.forMs ? { until: at + rule.forMs } : ctx.untilAt ? { until: ctx.untilAt } : {}),
    ...(rule.cap ? { cap: rule.cap } : {}),
    ...(ctx.code ? { code: ctx.code } : {}),
  };
}

/** A short line from an unfamiliar payload: its simple fields, so the notification says something without being a dump. */
function summary(value: any): string {
  const parts = Object.entries(value ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6).map(([k, v]) => `${label(k)}: ${String(v).slice(0, 80)}`);
  return parts.length ? parts.join('; ') : 'Meta sent an update with no simple fields.';
}

function effectsOf(rule: Rule, ctx: Record<string, any>, at: number): Effect[] {
  const effects: Effect[] = [];
  if (rule.tier && ctx.tier !== undefined) effects.push({ kind: 'tier', tier: ctx.tier });
  if (rule.template && ctx.message_template_name) {
    const key = templateKeyOf(ctx.message_template_name, ctx.message_template_language);
    effects.push({ kind: 'template', key, gate: rule.template === 'problem' ? { status: ctx.status, reason: ctx.reason, at } : null });
  }
  if (rule.name) effects.push({ kind: 'name', patch: Object.fromEntries(Object.entries(rule.name).map(([k, v]) => [k, v === null ? undefined : fill(v, ctx)])) });
  if (rule.scope && rule.why) {
    effects.push(rule.send ? { kind: 'set', scope: rule.scope, why: rule.why, issue: issueFrom({ ...rule, send: rule.send }, ctx, at) } : { kind: 'clear', scope: rule.scope, why: rule.why });
  }
  return effects;
}

const SEVERITY = { disable: 'critical', block: 'critical', limit: 'warning' } as const;

function toEvent(field: string, value: any, at: number): Omit<WebhookEvent, 'wabaId' | 'eventAt' | 'field' | 'value'> | null {
  const picked = PICK[field]?.(value) ?? {};
  const rule = (picked.variant ? ruleFor(`${field}:${picked.variant}`) : undefined) ?? RULES[field];
  const event = String(picked.vars?.event ?? picked.vars?.decision ?? picked.variant ?? '') || undefined;
  if (!rule) {
    // Anything else Meta reports about the account is kept as it arrives, so it can be read in the notifications and
    // handled once we know what it says. It gates nothing.
    return NEVER_KEPT.test(field) ? null : { notification: { title: `Meta reported: ${label(field)}`, message: summary(value), severity: 'info' }, effects: [] };
  }
  const ctx = { ...value, ...picked.vars };
  return {
    event,
    displayPhone: picked.displayPhone,
    notification: { title: fill(rule.title, ctx), message: fill(rule.message, ctx), severity: picked.severity ?? rule.severity ?? (rule.send ? SEVERITY[rule.send] : 'info') },
    effects: effectsOf(rule, ctx, at),
  };
}

/** A webhook body as events. Fields we don't handle (messages, syncs, echoes, calls ...) give none. */
export function parseWebhook(body: any): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  for (const entry of body?.entry ?? []) {
    const eventAt = Number(entry?.time) ? Number(entry.time) * 1000 : Date.now();
    for (const c of entry?.changes ?? []) {
      const parsed = entry?.id && c?.field ? toEvent(String(c.field), c.value ?? {}, eventAt) : null;
      if (parsed) events.push({ wabaId: String(entry.id), eventAt, field: String(c.field), value: c.value, ...parsed });
    }
  }
  return events;
}

/**
 * What an event does to a number's record: the new `health`, `displayName` and `templates`, or null when it
 * changes nothing (it was about something we already know better, or older). Each issue is only ever touched
 * by what it is about, and an event older than what is stored for that issue is ignored.
 */
export function applyEffects(doc: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'>, effects: Effect[], eventAt: number): Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> | null {
  let { health, displayName, templates } = doc;
  const patch: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> = {};
  for (const effect of effects) {
    if (effect.kind === 'set' || effect.kind === 'clear') {
      const next = effect.kind === 'set' ? setIssue(health, effect.scope, effect.why, effect.issue) : clearIssue(health, effect.scope, effect.why, eventAt);
      if (next) patch.health = health = next;
    } else if (effect.kind === 'tier') {
      patch.health = health = { ...health, tier: effect.tier ?? undefined };
    } else if (effect.kind === 'name') {
      if ((displayName?.at ?? 0) <= eventAt) patch.displayName = displayName = { ...displayName, ...effect.patch, at: eventAt };
    } else if (effect.kind === 'template') {
      const existing = templates?.[effect.key];
      if (existing && existing.at > eventAt) continue;
      const next = { ...(templates ?? {}) };
      if (effect.gate) next[effect.key] = effect.gate;
      else delete next[effect.key];
      patch.templates = templates = next;
    }
  }
  return Object.keys(patch).length ? patch : null;
}
