import { SCOPES, counts, issuesOf, templateKeyOf, worst } from './sendGate';
import { UNITS } from './rateLimiter';
import type { DisplayNameState, Issue, Limits, NotificationDoc, NumberHealth, PhoneNumberDoc, Scope, ScopeHealth, Send, TemplateGate, Why } from './types';

// What each signal about a number says to the user and does to the gates, as data: Meta's account-level
// webhooks, what a refresh finds in Meta's health read, and what a refused send tells us.
//
// A signal is looked up by `source:variant` (a webhook's `field:variant`, `code:141006`, `phone_status:BANNED`,
// `refusal:131042` ...) and falls back to `source`. A row has the notification (title, message) and, if it
// bears on sending, a `scope` and `why` with either a `send` (it restricts sending until it is cleared, or
// until its `until`) or `clear`. It may also set Meta's daily limit, update the display name, or mark a template.
//
// In texts, {{path}} is a value from the payload (a dotted path; a list is joined), {{path|label}} writes it in
// lower case without underscores, and [ ... ] is left out when a value inside it is missing.

export const LINKS = {
  manager: 'https://business.facebook.com/latest/whatsapp_manager/',
  business: 'https://business.facebook.com/latest/settings',
  reconnect: 'https://watobot.com/dashboard/waba/create.html',
  names: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names',
} as const;

/** The most template messages a day a limited number may send. Our own cautious figure, not Meta's. */
export const LIMITED_DAILY_TEMPLATES = 5;
const LIMITED: Limits = { day: LIMITED_DAILY_TEMPLATES };
const HOUR = 60 * 60 * 1000;

export interface Rule {
  title: string;
  message: string;
  /** For the notification; by default what `send` implies. */
  severity?: NotificationDoc['severity'];
  scope?: Scope;
  why?: Why;
  /** What the issue does to sending. Without it, a row with a scope and why clears that issue. */
  send?: Exclude<Send, 'ok'>;
  /** The most template messages the issue allows per window. */
  cap?: Limits;
  link?: keyof typeof LINKS;
  /** How long the issue lasts from when it is learned. */
  forMs?: number;
  /** Set Meta's daily messaging limit from the payload. */
  tier?: boolean;
  /** Changes to the display name state; texts are filled in, `null` removes a value. */
  name?: { [K in keyof DisplayNameState]?: string | null };
  /** The template named in the payload is in trouble, or has recovered. */
  template?: 'problem' | 'recover';
}

const ASK = 'Open WhatsApp Manager and Business Support to see why and whether you can appeal.';
const REENTER = 'Onboard the number again to reconnect it.';
const REFRESH = 'Then refresh.';

export const RULES: Record<string, Rule> = {
  // ---- webhooks ----
  'account_update:DISABLED_UPDATE': {
    title: 'Account disabled', message: `Meta has disabled this account[ ({{ban_info.waba_ban_date}})] for breaking its policies. Nothing can be sent. ${ASK}`,
    scope: 'account', why: 'ban', send: 'disable', link: 'manager',
  },
  'account_update:DISABLED_UPDATE:SCHEDULED': {
    title: 'Account scheduled to be disabled', message: `Meta has scheduled this account to be disabled[ ({{ban_info.waba_ban_date}})] for breaking its policies. Nothing can be sent. ${ASK}`,
    scope: 'account', why: 'ban', send: 'disable', link: 'manager',
  },
  'account_update:DISABLED_UPDATE:LIFTED': { title: 'Account reinstated', message: 'Meta has lifted the ban on this account.', scope: 'account', why: 'ban' },
  'account_update:ACCOUNT_RESTRICTION': {
    title: 'Account restricted',
    message: 'Meta restricts this account ({{kinds|label}})[ until {{until}}]. Template messages are refused meanwhile; replies in a chat still go. Open WhatsApp Manager to see the restriction and what lifts it.',
    scope: 'account', why: 'restriction', send: 'block', link: 'manager',
  },
  'account_update:ACCOUNT_RESTRICTION:OTHER': { title: 'Account restricted', message: 'Meta restricts this account ({{kinds|label}})[ until {{until}}].', severity: 'critical' },
  'account_update:ACCOUNT_RESTRICTION:LIFTED': { title: 'Restriction lifted', message: 'Meta has lifted the restriction on this account.', scope: 'account', why: 'restriction' },
  'account_update:ACCOUNT_VIOLATION': {
    title: 'Policy violation reported', message: 'Meta says the account violated its policies ({{violation_info.violation_type|label}}). Restrictions may follow.', severity: 'critical',
  },
  'account_update:ACCOUNT_DELETED': {
    title: 'Account deleted', message: 'The WhatsApp Business Account was deleted, so nothing can be sent. Onboard the number again if you still need it.',
    scope: 'account', why: 'ban', send: 'disable', link: 'reconnect',
  },
  'account_update:DISCONNECTED': {
    title: 'Number disconnected',
    message: `The number was disconnected from Watobot[ ({{disconnection_info.reason|label}}, started by {{disconnection_info.initiated_by|label}})], so nothing can be sent. ${REENTER}`,
    scope: 'account', why: 'connection', send: 'disable', link: 'reconnect',
  },
  'account_update:UNINSTALLED': {
    title: 'Number disconnected', message: `The account's owner removed Watobot's access, so nothing can be sent. ${REENTER}`,
    scope: 'account', why: 'connection', send: 'disable', link: 'reconnect',
  },
  'account_update:CONNECTED': { title: 'Number connected', message: 'The number is connected to Watobot.', scope: 'account', why: 'connection' },
  // Any other account update is a notification and gates nothing.
  account_update: { title: 'Account update: {{event|label}}', message: 'Meta reported a change to the account. It does not affect sending.' },

  'account_review_update:APPROVED': { title: 'Account approved', message: "Meta's review of the account is approved.", scope: 'account', why: 'review' },
  account_review_update: {
    title: 'Account review: {{decision|label}}',
    message: "Meta's review of the account is {{decision|label}}, and until it is approved the account cannot be used with the API. Open WhatsApp Manager and Business Support to see what Meta needs.",
    scope: 'account', why: 'review', send: 'disable', link: 'manager',
  },

  'phone_number_name_update:APPROVED': {
    title: 'Display name approved', message: 'Meta approved the display name "{{requested_verified_name}}".',
    name: { name: '{{requested_verified_name}}', status: 'APPROVED', requestedName: null, requestedStatus: 'NONE' },
    scope: 'display_name', why: 'name',
  },
  'phone_number_name_update:REJECTED': {
    title: 'Display name declined', message: 'Meta declined the display name "{{requested_verified_name}}"[ ({{rejection_reason|label}})]. Request a different name that follows the guidelines.',
    severity: 'warning', name: { requestedName: '{{requested_verified_name}}', requestedStatus: 'DECLINED' },
  },
  phone_number_name_update: {
    title: 'Display name in review', message: 'Meta is still reviewing the display name "{{requested_verified_name}}".',
    name: { requestedName: '{{requested_verified_name}}', requestedStatus: 'PENDING_REVIEW' },
  },

  'phone_number_quality_update:FLAGGED': {
    title: 'Number flagged',
    message: `Meta flagged this number because of how its messages are received. Watobot allows only ${LIMITED_DAILY_TEMPLATES} template messages a day until it clears. Pause campaigns, send only to people who asked for them, and review your templates. ${REFRESH}`,
    scope: 'phone', why: 'quality', send: 'limit', cap: LIMITED, link: 'manager', tier: true,
  },
  'phone_number_quality_update:UNFLAGGED': { title: 'Number unflagged', message: 'Meta reported unflagged[; the messaging limit is now {{tierName}}].', scope: 'phone', why: 'quality', tier: true },
  phone_number_quality_update: { title: 'Number update: {{event|label}}', message: 'Meta reported {{event|label}}[; the messaging limit is now {{tierName}}].', tier: true },

  business_capability_update: { title: 'Account capabilities changed', message: 'Meta changed the limits on the number of phone numbers.' },
  'business_capability_update:TIER': { title: 'Messaging limit: {{tierName}}', message: "The business's messaging limit is now {{tierName}}.", tier: true },

  account_alerts: { title: 'Alert: {{alert_info.alert_type|label}}', message: '{{alert_info.alert_description}}' },
  security: { title: 'Security settings changed', message: "Meta reported a change to the number's security settings." },

  'message_template_status_update:QUALITY': {
    title: 'Template quality: {{new_quality_score|label}}',
    message: 'The quality of "{{message_template_name}}" went from {{previous_quality_score|label}} to {{new_quality_score|label}}.',
  },
  'message_template_status_update:PROBLEM': {
    title: 'Template {{status|label}}', severity: 'warning', template: 'problem',
    message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})]. It is not sent until it is fixed or reinstated.',
  },
  'message_template_status_update:RECOVERED': {
    title: 'Template {{status|label}}', template: 'recover',
    message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})].',
  },
  message_template_status_update: { title: 'Template {{status|label}}', message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})].' },

  // ---- what a refresh finds in Meta's health read ----
  'code:141006': {
    title: 'Payment method problem',
    message: `Meta can't use the account's payment method, so it blocks template (business-initiated) messages. Replies within 24 hours of a customer's message still go through. Open WhatsApp Manager, go to the account's payment settings and add or fix a payment method. ${REFRESH}`,
    scope: 'account', why: 'payment', send: 'block', link: 'manager',
  },
  'code:141010': {
    title: 'Business unverified',
    message: `Your business hasn't passed Meta's business verification. Until it does, Meta caps you at 250 customers a day, and Watobot's daily limit stays under that. Everything else works. Optional: to raise the cap, start business verification in Business Settings, under Security Center. ${REFRESH}`,
    scope: 'business', why: 'business', send: 'limit', link: 'business',
  },
  'phone_note:display_name': {
    title: 'Display name not approved yet',
    message: `{{note}} Until it is approved the number can send only a few template messages a day (Watobot allows ${LIMITED_DAILY_TEMPLATES}). Replies in a chat are not limited. Wait for Meta's decision. If you haven't requested a name, or it was declined, request one that follows the guidelines.`,
    scope: 'display_name', why: 'name', send: 'limit', cap: LIMITED, link: 'names',
  },
  'phone_status:BANNED': { title: 'Number banned', message: `Meta has banned this number, so nothing can be sent from it. ${ASK}`, scope: 'phone', why: 'ban', send: 'disable', link: 'manager' },
  'phone_status:DELETED': { title: 'Number deleted', message: 'This number has been deleted from the account. Onboard it again if you still need it.', scope: 'phone', why: 'ban', send: 'disable', link: 'manager' },
  'phone_status:DISCONNECTED': { title: 'Number disconnected', message: 'The number is disconnected from the Cloud API, so nothing can be sent. Register it again, or onboard it again.', scope: 'phone', why: 'connection', send: 'disable', link: 'manager' },
  'phone_status:MIGRATED': { title: 'Number moved', message: 'This number has been moved to another account. Onboard it again here if you want it back.', scope: 'phone', why: 'connection', send: 'disable', link: 'manager' },
  'phone_status:RESTRICTED': { title: 'Number restricted', message: 'Meta restricts this number, so template messages are refused. Open WhatsApp Manager to see the restriction and what lifts it.', scope: 'phone', why: 'restriction', send: 'block', link: 'manager' },
  'phone_status:FLAGGED': {
    title: 'Number flagged', message: 'Meta has flagged this number because of how its messages are received, and may lower its limits. Pause campaigns and review your templates and who you message.',
    scope: 'phone', why: 'quality', send: 'limit', cap: LIMITED, link: 'manager',
  },
  'phone_status:RATE_LIMITED': {
    title: 'Number rate limited', message: 'Meta is limiting how much this number can send. Slow down and wait before sending more.',
    scope: 'phone', why: 'quality', send: 'limit', cap: LIMITED, link: 'manager',
  },
  review: {
    title: 'Account review: {{status|label}}',
    message: "Meta's review of the account is {{status|label}}, and until it is approved the account cannot be used with the API. Open WhatsApp Manager and Business Support to see what Meta needs.",
    scope: 'account', why: 'review', send: 'disable', link: 'manager',
  },
  'quality:RED': {
    title: 'Message quality is low',
    message: `Customers are blocking or reporting your messages more than Meta likes. If it stays low, Meta lowers your limit or blocks the number. Pause campaigns, send only to people who asked to hear from you, and review your templates. ${REFRESH}`,
    scope: 'phone', why: 'quality', send: 'limit', cap: LIMITED, link: 'manager',
  },

  // ---- what a refused send tells us ----
  'refusal:131042': {
    title: 'Payment method problem',
    message: "Meta refused a send because of the account's payment method ({{detail}}). Template messages are blocked until it is fixed; replies still go through. Open WhatsApp Manager, go to the account's payment settings and add or fix a payment method.",
    scope: 'account', why: 'payment', send: 'block', link: 'manager',
  },
  'refusal:131031': {
    title: 'Account locked', message: `Meta refused a send because the account is locked ({{detail}}). ${ASK}`,
    scope: 'account', why: 'ban', send: 'disable', link: 'manager',
  },
  'refusal:131048': {
    title: 'Template messages paused',
    message: 'Meta says this number is sending more than recipients want (a spam rate limit, {{detail}}). Watobot pauses its template messages for an hour so that more sends do not make it worse. Replies still go through. Cut how many template messages you send, send only to people who asked for them, and review your templates.',
    scope: 'phone', why: 'cooldown', send: 'block', forMs: HOUR, link: 'manager',
  },
};

/** Several of Meta's events say the same thing. */
export const ALIASES: Record<string, string> = {
  'account_update:PARTNER_REMOVED': 'account_update:DISCONNECTED',
  'account_update:ACCOUNT_OFFBOARDED': 'account_update:DISCONNECTED',
  'account_update:PARTNER_APP_UNINSTALLED': 'account_update:UNINSTALLED',
  'account_update:PARTNER_ADDED': 'account_update:CONNECTED',
  'account_update:ACCOUNT_RECONNECTED': 'account_update:CONNECTED',
  'account_update:PARTNER_APP_INSTALLED': 'account_update:CONNECTED',
};

/** What a payload gives besides its own fields: which row it is (`variant`), values to fill in, and who it is about. */
export interface Picked {
  variant?: string;
  vars?: Record<string, unknown>;
  displayPhone?: string;
  severity?: NotificationDoc['severity'];
}

/** The daily number of customers a Meta messaging limit tier allows, e.g. TIER_250 -> 250. Undefined if unknown or unlimited. */
export function tierLimit(tier?: string): number | undefined {
  const match = /^TIER_(\d+)(K)?$/.exec(tier ?? '');
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : undefined;
}

/** Meta's tier names are TIER_250, TIER_2K ...; TIER_NOT_SET and anything else is not a limit. */
const asTier = (value: unknown) => (typeof value === 'string' && /^TIER_(\d+K?|UNLIMITED)$/.test(value) ? value : undefined);
/** `tier` is the daily number of customers, or null when there is no limit. */
const tierVars = (tier: string | undefined) => (tier ? { tier: tierLimit(tier) ?? null, tierName: tier.replace('TIER_', '') } : {});
const upper = (v: unknown) => String(v ?? '').toUpperCase();

/** How each field's payload picks its row, and the values its texts need. */
export const PICK: Record<string, (value: any) => Picked> = {
  account_update(value) {
    const event = String(value?.event ?? '');
    const base = { displayPhone: value?.phone_number, vars: { event } };
    if (event === 'DISABLED_UPDATE') {
      const states = ([] as string[]).concat(value?.ban_info?.waba_ban_state ?? []).map(upper);
      if (states.includes('REINSTATE')) return { ...base, variant: 'DISABLED_UPDATE:LIFTED' };
      return { ...base, variant: states.includes('SCHEDULE_FOR_DISABLE') && !states.includes('DISABLE') ? 'DISABLED_UPDATE:SCHEDULED' : 'DISABLED_UPDATE' };
    }
    if (event === 'ACCOUNT_RESTRICTION') {
      const restrictions: { restriction_type?: string; expiration?: number }[] = value?.restriction_info ?? [];
      const biz = restrictions.find((r) => r.restriction_type === 'RESTRICTED_BIZ_INITIATED_MESSAGING');
      const expiration = (biz ?? restrictions[0])?.expiration;
      const vars = { event, kinds: restrictions.map((r) => r.restriction_type), until: expiration ? new Date(expiration * 1000).toUTCString() : undefined, untilAt: biz?.expiration ? biz.expiration * 1000 : undefined };
      return { ...base, vars, variant: !restrictions.length ? 'ACCOUNT_RESTRICTION:LIFTED' : biz ? 'ACCOUNT_RESTRICTION' : 'ACCOUNT_RESTRICTION:OTHER' };
    }
    return { ...base, variant: event };
  },
  account_review_update(value) {
    const decision = upper(value?.decision);
    return { variant: decision === 'APPROVED' ? 'APPROVED' : undefined, vars: { decision: decision || 'unknown' } };
  },
  phone_number_name_update(value) {
    const decision = upper(value?.decision);
    return { variant: decision === 'APPROVED' || decision === 'REJECTED' ? decision : undefined, displayPhone: value?.display_phone_number };
  },
  phone_number_quality_update(value) {
    const event = String(value?.event ?? '');
    const tier = asTier(value?.max_daily_conversations_per_business) ?? asTier(value?.current_limit);
    return { variant: upper(event), displayPhone: value?.display_phone_number, vars: { event: event || 'a change', ...tierVars(tier) } };
  },
  business_capability_update(value) {
    const tier = asTier(value?.max_daily_conversations_per_business);
    return { variant: tier ? 'TIER' : undefined, vars: tierVars(tier) };
  },
  account_alerts(value) {
    const alert = value?.alert_info ?? {};
    const severity = /crit|high|error/i.test(String(alert.alert_severity)) ? 'critical' : /warn|med/i.test(String(alert.alert_severity)) ? 'warning' : 'info';
    return { severity, vars: { event: alert.alert_type } };
  },
  message_template_status_update(value) {
    // A template's quality change arrives under the status field's name in Meta's docs, so it is told apart by its keys.
    if (value?.new_quality_score) return { variant: 'QUALITY', severity: /RED|YELLOW/i.test(String(value.new_quality_score)) ? 'warning' : 'info' };
    const status = upper(value?.event);
    const vars = { status, event: status, reason: value?.reason && value.reason !== 'NONE' ? String(value.reason) : undefined };
    if (['PAUSED', 'DISABLED', 'REJECTED', 'DELETED', 'PENDING_DELETION'].includes(status)) return { variant: 'PROBLEM', vars };
    return { variant: ['APPROVED', 'REINSTATED'].includes(status) ? 'RECOVERED' : undefined, vars };
  },
};

/** Fields that carry what customers wrote or did, or who they are: never read, never kept. */
export const NEVER_KEPT = /^(messages|message_echoes|smb_message_echoes|smb_app_state_sync|history|calls|flows|standby|messaging_handovers|user_preferences|tracking_events|automatic_events|group_.*)$/;


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
 * The health with expired issues dropped and everything worked out again from what is left: each scope's status,
 * the worst status, and the lowest ceiling per window across the issues and Meta's daily limit. Every write to
 * the health ends with this, so the stored values always match the stored issues.
 */
export function settle(health: Partial<NumberHealth> | undefined, now: number): NumberHealth {
  const next = { status: 'ok', limits: health?.tier ? { day: health.tier } : {}, ...(health?.tier ? { tier: health.tier } : {}) } as NumberHealth;
  const all: Issue[] = [];
  for (const scope of SCOPES) {
    const own = issuesOf(health?.[scope] as ScopeHealth | undefined).filter(([, issue]) => counts(issue, now));
    if (!own.length) continue;
    next[scope] = { status: worst(own.map(([, issue]) => issue)), ...Object.fromEntries(own) } as ScopeHealth;
    for (const [, issue] of own) {
      all.push(issue);
      for (const unit of UNITS) if (issue.cap?.[unit] !== undefined) next.limits[unit] = Math.min(next.limits[unit] ?? Infinity, issue.cap[unit]!);
    }
  }
  next.status = worst(all);
  return next;
}

/** The health with this issue set, replacing what the same scope and cause said before. Null if what is stored is newer. */
export function setIssue(health: NumberHealth | undefined, scope: Scope, why: Why, issue: Issue, now: number): NumberHealth | null {
  if ((health?.[scope]?.[why]?.at ?? 0) > issue.at) return null;
  return settle({ ...health, [scope]: { ...health?.[scope], [why]: issue } }, now);
}

/** The health without this issue, and only it: a lifted ban leaves a payment problem where it is. Null if there is nothing to clear, or it is newer. */
export function clearIssue(health: NumberHealth | undefined, scope: Scope, why: Why, at: number, now: number): NumberHealth | null {
  const existing = health?.[scope]?.[why];
  if (!health || !existing || existing.at > at) return null;
  const { [why]: _gone, ...rest } = health[scope]!;
  return settle({ ...health, [scope]: rest }, now);
}

/**
 * What an event does to a number's record: the new `health`, `displayName` and `templates`, or null when it
 * changes nothing (it was about something we already know better, or older). Each issue is only ever touched
 * by what it is about, and an event older than what is stored for that issue is ignored.
 */
export function applyEffects(doc: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'>, effects: Effect[], eventAt: number, now = Date.now()): Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> | null {
  let { health, displayName, templates } = doc;
  const patch: Pick<PhoneNumberDoc, 'health' | 'displayName' | 'templates'> = {};
  for (const effect of effects) {
    if (effect.kind === 'set' || effect.kind === 'clear') {
      const next = effect.kind === 'set' ? setIssue(health, effect.scope, effect.why, effect.issue, now) : clearIssue(health, effect.scope, effect.why, eventAt, now);
      if (next) patch.health = health = next;
    } else if (effect.kind === 'tier') {
      patch.health = health = settle({ ...health, tier: effect.tier ?? undefined }, now);
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
