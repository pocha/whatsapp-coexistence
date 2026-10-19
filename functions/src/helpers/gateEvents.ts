import { clear, counts, raise, settle } from './gates';
import { LIMITED_DAILY_TEMPLATES } from './health';
import { templateKeyOf } from './gates';
import type { DisplayNameState, GateCause, HealthReason, NotificationDoc, PhoneNumberDoc, TemplateGate } from './types';

// What Meta's webhooks tell us about a number's account, in two steps: parseWebhook turns a payload into
// events (what to show in the Notifications, and what the event does to the gates), and applyEffects applies
// those to a number's record. Both are pure. Only account-level fields are handled; a `messages` event, a
// history or contacts sync or an echo is never looked at, let alone kept.

const WHATSAPP_MANAGER = 'https://business.facebook.com/latest/whatsapp_manager/';
const RECONNECT = 'https://watobot.com/dashboard/waba/create.html';
const DISPLAY_NAME_GUIDELINES = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names';

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

function reason(at: number, r: Omit<HealthReason, 'at' | 'scope'> & { scope?: string }): HealthReason {
  return { scope: 'WABA', ...r, at };
}

/** Meta's tier names are TIER_250, TIER_2K ...; TIER_NOT_SET and anything else is not a limit. */
const asTier = (value: unknown) => (typeof value === 'string' && /^TIER_(\d+K?|UNLIMITED)$/.test(value) ? value : undefined);

function accountUpdate(value: any, at: number): Pick<WebhookEvent, 'notification' | 'effects'> & { event?: string } {
  const event = String(value?.event ?? '');
  const note = (title: string, message: string, severity: NotificationDoc['severity'] = 'info') => ({ title, message, severity });
  switch (event) {
    case 'DISABLED_UPDATE': {
      const states = ([] as string[]).concat(value?.ban_info?.waba_ban_state ?? []).map((s) => String(s).toUpperCase());
      if (states.includes('REINSTATE')) {
        return { event, notification: note('Account reinstated', 'Meta has lifted the ban on this account.'), effects: [{ kind: 'clear', cause: 'ban' }] };
      }
      const scheduled = states.includes('SCHEDULE_FOR_DISABLE') && !states.includes('DISABLE');
      const text = `Meta ${scheduled ? 'has scheduled this account to be disabled' : 'has disabled this account'}${value?.ban_info?.waba_ban_date ? ` (${value.ban_info.waba_ban_date})` : ''} for breaking its policies. Nothing can be sent.`;
      return {
        event,
        notification: note(scheduled ? 'Account scheduled to be disabled' : 'Account disabled', text, 'critical'),
        effects: [{ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'ban', severity: 'disabled', title: scheduled ? 'Account scheduled to be disabled' : 'Account disabled', message: text, action: 'Open WhatsApp Manager and Business Support to see why and whether you can appeal.', link: WHATSAPP_MANAGER }) }],
      };
    }
    case 'ACCOUNT_RESTRICTION': {
      const restrictions: { restriction_type?: string; expiration?: number }[] = value?.restriction_info ?? [];
      const biz = restrictions.find((r) => r.restriction_type === 'RESTRICTED_BIZ_INITIATED_MESSAGING');
      if (!restrictions.length) {
        return { event, notification: note('Restriction lifted', 'Meta has lifted the restriction on this account.'), effects: [{ kind: 'clear', cause: 'restriction' }] };
      }
      const until = biz?.expiration ? biz.expiration * 1000 : undefined;
      const text = `Meta restricts this account (${restrictions.map((r) => label(String(r.restriction_type))).join(', ')})${until ? ` until ${new Date(until).toUTCString()}` : ''}.${biz ? ' Template messages are refused meanwhile; replies in a chat still go.' : ''}`;
      return {
        event,
        notification: note('Account restricted', text, 'critical'),
        effects: biz ? [{ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'restriction', severity: 'blocked', until, title: 'Account restricted', message: text, action: 'Open WhatsApp Manager to see the restriction and what lifts it.', link: WHATSAPP_MANAGER }) }] : [],
      };
    }
    case 'ACCOUNT_VIOLATION':
      return { event, notification: note('Policy violation reported', `Meta says the account violated its policies (${label(String(value?.violation_info?.violation_type ?? 'unspecified'))}). Restrictions may follow.`, 'critical'), effects: [] };
    case 'ACCOUNT_DELETED':
      return {
        event,
        notification: note('Account deleted', 'The WhatsApp Business Account was deleted.', 'critical'),
        effects: [{ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'ban', severity: 'disabled', title: 'Account deleted', message: 'The WhatsApp Business Account was deleted, so nothing can be sent.', action: 'Onboard the number again if you still need it.', link: RECONNECT }) }],
      };
    case 'PARTNER_REMOVED':
    case 'ACCOUNT_OFFBOARDED':
    case 'PARTNER_APP_UNINSTALLED': {
      const info = value?.disconnection_info;
      const why = info ? ` (${label(String(info.reason ?? 'no reason given'))}, started by ${label(String(info.initiated_by ?? 'unknown'))})` : '';
      const text =
        event === 'PARTNER_APP_UNINSTALLED'
          ? "The account's owner removed Watobot's access, so nothing can be sent."
          : `The number was disconnected from Watobot${why}, so nothing can be sent.`;
      return {
        event,
        notification: note('Number disconnected', text, 'critical'),
        effects: [{ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'connection', severity: 'disabled', title: 'Number disconnected', message: text, action: 'Onboard the number again to reconnect it.', link: RECONNECT }) }],
      };
    }
    case 'PARTNER_ADDED':
    case 'ACCOUNT_RECONNECTED':
    case 'PARTNER_APP_INSTALLED':
      return { event, notification: note('Number connected', 'The number is connected to Watobot.'), effects: [{ kind: 'clear', cause: 'connection' }] };
    default:
      return { event, notification: note(`Account update: ${label(event || 'unspecified')}`, 'Meta reported a change to the account. It does not affect sending.'), effects: [] };
  }
}

function change(field: string, value: any, entry: any, at: number): Omit<WebhookEvent, 'wabaId' | 'eventAt' | 'field' | 'value'> | null {
  switch (field) {
    case 'account_update':
      return { ...accountUpdate(value, at), displayPhone: value?.phone_number };
    case 'account_review_update': {
      const decision = String(value?.decision ?? '').toUpperCase();
      if (decision === 'APPROVED') {
        return { event: decision, notification: { title: 'Account approved', message: "Meta's review of the account is approved.", severity: 'info' }, effects: [{ kind: 'clear', cause: 'review' }] };
      }
      const text = `Meta's review of the account is ${label(decision || 'unknown')}, and until it is approved the account cannot be used with the API.`;
      return {
        event: decision,
        notification: { title: `Account review: ${label(decision)}`, message: text, severity: 'critical' },
        effects: [{ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'review', severity: 'disabled', title: `Account review: ${label(decision)}`, message: text, action: 'Open WhatsApp Manager and Business Support to see what Meta needs.', link: WHATSAPP_MANAGER }) }],
      };
    }
    case 'phone_number_name_update': {
      const decision = String(value?.decision ?? '').toUpperCase();
      const name = value?.requested_verified_name;
      const phone = value?.display_phone_number;
      if (decision === 'APPROVED') {
        return {
          event: decision, displayPhone: phone,
          notification: { title: 'Display name approved', message: `Meta approved the display name "${name}".`, severity: 'info' },
          effects: [{ kind: 'name', patch: { name, status: 'APPROVED', requestedName: undefined, requestedStatus: 'NONE' } }, { kind: 'clear', cause: 'name' }],
        };
      }
      const declined = decision === 'REJECTED';
      const text = declined ? `Meta declined the display name "${name}"${value?.rejection_reason ? ` (${label(String(value.rejection_reason))})` : ''}.` : `Meta is still reviewing the display name "${name}".`;
      return {
        event: decision, displayPhone: phone,
        notification: { title: declined ? 'Display name declined' : 'Display name in review', message: text, severity: declined ? 'warning' : 'info' },
        effects: [
          { kind: 'name', patch: { requestedName: name, requestedStatus: declined ? 'DECLINED' : 'PENDING_REVIEW' } },
          { kind: 'raise', keepWorse: true, reason: reason(at, { chip: 'name', cause: 'name', scope: 'PHONE_NUMBER', severity: 'info', title: declined ? 'Display name declined' : 'Display name in review', message: text, action: declined ? 'Request a different name that follows the guidelines.' : "Wait for Meta's decision. Don't submit another name until it arrives.", link: DISPLAY_NAME_GUIDELINES }) },
        ],
      };
    }
    case 'phone_number_quality_update': {
      const tier = asTier(value?.max_daily_conversations_per_business) ?? asTier(value?.current_limit);
      const event = String(value?.event ?? '');
      const effects: Effect[] = [];
      if (tier) effects.push({ kind: 'tier', tier });
      if (event === 'FLAGGED') {
        effects.push({ kind: 'raise', reason: reason(at, { chip: 'status', cause: 'quality', scope: 'PHONE_NUMBER', severity: 'limited', title: 'Number flagged', message: `Meta flagged this number because of how its messages are received. Watobot allows only ${LIMITED_DAILY_TEMPLATES} template messages a day until it clears.`, action: 'Pause campaigns, send only to people who asked for them, and review your templates. Then refresh.', link: WHATSAPP_MANAGER }) });
      } else if (event === 'UNFLAGGED') effects.push({ kind: 'clear', cause: 'quality' });
      return {
        event, displayPhone: value?.display_phone_number,
        notification: { title: tier ? `Messaging limit: ${tier.replace('TIER_', '')}` : `Number update: ${label(event)}`, message: `Meta reported ${label(event || 'a change')}${tier ? `; the messaging limit is now ${tier.replace('TIER_', '')}` : ''}.`, severity: event === 'FLAGGED' ? 'warning' : 'info' },
        effects,
      };
    }
    case 'business_capability_update': {
      const tier = asTier(value?.max_daily_conversations_per_business);
      return {
        notification: { title: tier ? `Messaging limit: ${tier.replace('TIER_', '')}` : 'Account capabilities changed', message: tier ? `The business's messaging limit is now ${tier.replace('TIER_', '')}.` : 'Meta changed the limits on the number of phone numbers.', severity: 'info' },
        effects: tier ? [{ kind: 'tier', tier }] : [],
      };
    }
    case 'account_alerts': {
      const alert = value?.alert_info ?? {};
      const severity = /crit|high|error/i.test(String(alert.alert_severity)) ? 'critical' : /warn|med/i.test(String(alert.alert_severity)) ? 'warning' : 'info';
      return { event: alert.alert_type, notification: { title: `Alert: ${label(String(alert.alert_type ?? 'account'))}`, message: String(alert.alert_description ?? 'Meta sent an alert about the account.'), severity }, effects: [] };
    }
    case 'security':
      return { notification: { title: 'Security settings changed', message: "Meta reported a change to the number's security settings.", severity: 'info' }, effects: [] };
    case 'message_template_status_update': {
      // A template's quality change arrives with the status field's name in Meta's docs, so it is told apart by its keys.
      if (value?.new_quality_score) {
        const bad = /RED|YELLOW/i.test(String(value.new_quality_score));
        return { event: 'QUALITY', notification: { title: `Template quality: ${String(value.new_quality_score).toLowerCase()}`, message: `The quality of "${value.message_template_name}" went from ${String(value.previous_quality_score).toLowerCase()} to ${String(value.new_quality_score).toLowerCase()}.`, severity: bad ? 'warning' : 'info' }, effects: [] };
      }
      const status = String(value?.event ?? '').toUpperCase();
      const key = value?.message_template_name ? templateKeyOf(value.message_template_name, value.message_template_language) : undefined;
      const problem = ['PAUSED', 'DISABLED', 'REJECTED', 'DELETED', 'PENDING_DELETION'].includes(status);
      const recovered = ['APPROVED', 'REINSTATED'].includes(status);
      const reasonText = value?.reason && value.reason !== 'NONE' ? ` (${label(String(value.reason))})` : '';
      return {
        event: status,
        notification: {
          title: `Template ${label(status)}`,
          message: `The template "${value?.message_template_name}" (${value?.message_template_language}) is ${label(status)}${reasonText}.${problem ? ' It is not sent until it is fixed or reinstated.' : ''}`,
          severity: problem ? 'warning' : 'info',
        },
        effects: key ? (problem ? [{ kind: 'template', key, gate: { status, reason: value?.reason && value.reason !== 'NONE' ? String(value.reason) : undefined, at } }] : recovered ? [{ kind: 'template', key, gate: null }] : []) : [],
      };
    }
    default:
      // Anything else Meta reports about the account is kept as it arrives, so it can be read in the notifications and
      // handled once we know what it says. It gates nothing.
      return NEVER_KEPT.test(field) ? null : { notification: { title: `Meta reported: ${label(field)}`, message: summary(value), severity: 'info' }, effects: [] };
  }
}

/** Fields that carry what customers wrote or did, or who they are: never read, never kept. */
const NEVER_KEPT = /^(messages|message_echoes|smb_message_echoes|smb_app_state_sync|history|calls|flows|standby|messaging_handovers|user_preferences|tracking_events|automatic_events|group_.*)$/;

/** A short line from an unfamiliar payload: its simple fields, so the notification says something without being a dump. */
function summary(value: any): string {
  const parts = Object.entries(value ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6).map(([k, v]) => `${label(k)}: ${String(v).slice(0, 80)}`);
  return parts.length ? parts.join('; ') : 'Meta sent an update with no simple fields.';
}

/** A webhook body as events. Fields we don't handle (messages, syncs, echoes, calls ...) give none. */
export function parseWebhook(body: any): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  for (const entry of body?.entry ?? []) {
    const eventBase = Number(entry?.time) ? Number(entry.time) * 1000 : Date.now();
    for (const c of entry?.changes ?? []) {
      const parsed = entry?.id && c?.field ? change(String(c.field), c.value ?? {}, entry, eventBase) : null;
      if (parsed) events.push({ wabaId: String(entry.id), eventAt: eventBase, field: String(c.field), value: c.value, ...parsed });
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
