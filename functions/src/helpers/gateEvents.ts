import { clear, counts, raise, settle, templateKeyOf } from './gates';
import { LIMITED_DAILY_TEMPLATES } from './health';
import { ALIASES, LINKS, NEVER_KEPT, PICK, RULES, type Rule } from './webhookRules';
import type { DisplayNameState, GateCause, HealthReason, NotificationDoc, PhoneNumberDoc, TemplateGate } from './types';

// What Meta's webhooks tell us about a number's account, in two steps: parseWebhook turns a payload into
// events (what to show in the Notifications, and what the event does to the gates) using the rows in
// webhookRules.ts, and applyEffects applies those to a number's record. Both are pure. Only account-level
// fields are handled; a `messages` event, a history or contacts sync or an echo is never looked at, let alone kept.

export type Effect =
  | { kind: 'raise'; reason: HealthReason; /** Keep the worse of this and what that cause says now. */ keepWorse?: boolean }
  | { kind: 'clear'; cause: GateCause }
  | { kind: 'name'; patch: Partial<DisplayNameState> }
  | { kind: 'tier'; tier: string }
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

const RANK = { info: 0, limited: 1, blocked: 2, disabled: 3 } as const;
const label = (text: string) => text.toLowerCase().replace(/_/g, ' ');

/** Fills a row's text from the payload and the values its field picked. See webhookRules.ts for the syntax. */
function fill(text: string, ctx: Record<string, any>): string {
  const render = (part: string) => {
    let missing = false;
    const out = part.replace(/\{\{([\w.]+)(?:\|(label))?\}\}/g, (_, path: string, filter?: string) => {
      let v: any = path.split(".").reduce((o: any, k) => o?.[k], ctx);
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

/** A short line from an unfamiliar payload: its simple fields, so the notification says something without being a dump. */
function summary(value: any): string {
  const parts = Object.entries(value ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6).map(([k, v]) => `${label(k)}: ${String(v).slice(0, 80)}`);
  return parts.length ? parts.join('; ') : 'Meta sent an update with no simple fields.';
}

function effectsOf(rule: Rule, ctx: Record<string, any>, at: number): Effect[] {
  const effects: Effect[] = [];
  if (rule.tier && ctx.tier) effects.push({ kind: 'tier', tier: ctx.tier });
  if (rule.template && ctx.message_template_name) {
    const key = templateKeyOf(ctx.message_template_name, ctx.message_template_language);
    effects.push({ kind: 'template', key, gate: rule.template === 'problem' ? { status: ctx.status, reason: ctx.reason, at } : null });
  }
  if (rule.name) effects.push({ kind: 'name', patch: Object.fromEntries(Object.entries(rule.name).map(([k, v]) => [k, v === null ? undefined : fill(v, ctx)])) });
  const r = rule.raise;
  if (r) {
    const reason: HealthReason = {
      chip: r.chip ?? 'status',
      cause: r.cause,
      scope: r.scope ?? 'WABA',
      severity: r.blocks,
      title: fill(r.title ?? rule.title, ctx),
      message: fill(r.message ?? rule.message, ctx),
      action: r.action,
      link: LINKS[r.link],
      at,
      ...(ctx.untilAt ? { until: ctx.untilAt } : {}),
    };
    effects.push({ kind: 'raise', reason, keepWorse: r.keepWorse });
  }
  if (rule.clear) effects.push({ kind: 'clear', cause: rule.clear });
  return effects;
}

function toEvent(field: string, value: any, at: number): Omit<WebhookEvent, 'wabaId' | 'eventAt' | 'field' | 'value'> | null {
  const picked = PICK[field]?.(value) ?? {};
  const key = picked.variant ? `${field}:${picked.variant}` : field;
  const rule = RULES[ALIASES[key] ?? key] ?? RULES[field];
  const event = String(picked.vars?.event ?? picked.vars?.decision ?? picked.variant ?? '') || undefined;
  if (!rule) {
    // Anything else Meta reports about the account is kept as it arrives, so it can be read in the notifications and
    // handled once we know what it says. It gates nothing.
    return NEVER_KEPT.test(field) ? null : { notification: { title: `Meta reported: ${label(field)}`, message: summary(value), severity: 'info' }, effects: [] };
  }
  const ctx = { ...value, ...picked.vars, limitedDaily: LIMITED_DAILY_TEMPLATES };
  return {
    event,
    displayPhone: picked.displayPhone,
    notification: { title: fill(rule.title, ctx), message: fill(rule.message, ctx), severity: picked.severity ?? rule.severity ?? 'info' },
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
 * changes nothing (it was about something we already know better, or older). Each cause is only ever touched
 * by what it is about, and an event older than what is stored for that cause is ignored.
 */
export function applyEffects(doc: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'>, effects: Effect[], eventAt: number, now: number): Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> | null {
  let { health, displayName, templates } = doc;
  const patch: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> = {};
  for (const effect of effects) {
    if (effect.kind === 'raise') {
      const reasonToSet = { ...effect.reason };
      const current = health?.reasons.find((r) => r.cause === reasonToSet.cause && counts(r, now));
      if (effect.keepWorse && current && RANK[current.severity] > RANK[reasonToSet.severity]) reasonToSet.severity = current.severity;
      const next = raise(health, reasonToSet, now);
      if (next) patch.health = health = next;
    } else if (effect.kind === 'clear') {
      const next = clear(health, effect.cause, eventAt, now);
      if (next) patch.health = health = next;
    } else if (effect.kind === 'tier') {
      patch.health = health = settle({ ...health, tier: effect.tier }, health?.reasons ?? [], now);
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
