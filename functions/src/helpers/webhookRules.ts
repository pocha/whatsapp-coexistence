import type { DisplayNameState, GateCause, HealthReason, NotificationDoc } from './types';

// What each of Meta's account-level webhooks says to the user and does to the gates, as data.
//
// A webhook is looked up by `field:variant` (see PICK for how a payload gives its variant) and falls back to
// `field`. A row has the notification (title, message, severity) and, optionally, what it does to the number:
// raise a reason, clear a cause, set the tier, update the display name, or mark a template.
//
// In texts, {{path}} is a value from the payload (a dotted path; a list is joined), {{path|label}} writes it in
// lower case without underscores, and [ ... ] is left out when a value inside it is missing.

export const LINKS = {
  manager: 'https://business.facebook.com/latest/whatsapp_manager/',
  reconnect: 'https://watobot.com/dashboard/waba/create.html',
  names: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names',
} as const;

export interface Rule {
  title: string;
  message: string;
  severity?: NotificationDoc['severity'];
  /** A reason that counts against sending until it is cleared (or until its `until`). `title` and `message` default to the notification's. */
  raise?: {
    cause: GateCause;
    /** What it stops: `disabled` everything, `blocked` template messages, `limited` most of them, `info` nothing. */
    blocks: HealthReason['severity'];
    chip?: HealthReason['chip'];
    scope?: string;
    title?: string;
    message?: string;
    action: string;
    link: keyof typeof LINKS;
    /** Keep the worse of this and what the cause already says. */
    keepWorse?: boolean;
  };
  clear?: GateCause;
  /** Set the messaging tier from the payload. */
  tier?: boolean;
  /** Changes to the display name state; texts are filled in, `null` removes a value. */
  name?: { [K in keyof DisplayNameState]?: string | null };
  /** The template named in the payload is in trouble, or has recovered. */
  template?: 'problem' | 'recover';
}

const CONNECTED = { title: 'Number connected', message: 'The number is connected to Watobot.', clear: 'connection' } as const;
const DISCONNECT_ACTION = 'Onboard the number again to reconnect it.';

export const RULES: Record<string, Rule> = {
  'account_update:DISABLED_UPDATE': {
    title: 'Account disabled',
    message: 'Meta has disabled this account[ ({{ban_info.waba_ban_date}})] for breaking its policies. Nothing can be sent.',
    severity: 'critical',
    raise: { cause: 'ban', blocks: 'disabled', action: 'Open WhatsApp Manager and Business Support to see why and whether you can appeal.', link: 'manager' },
  },
  'account_update:DISABLED_UPDATE:SCHEDULED': {
    title: 'Account scheduled to be disabled',
    message: 'Meta has scheduled this account to be disabled[ ({{ban_info.waba_ban_date}})] for breaking its policies. Nothing can be sent.',
    severity: 'critical',
    raise: { cause: 'ban', blocks: 'disabled', action: 'Open WhatsApp Manager and Business Support to see why and whether you can appeal.', link: 'manager' },
  },
  'account_update:DISABLED_UPDATE:LIFTED': { title: 'Account reinstated', message: 'Meta has lifted the ban on this account.', clear: 'ban' },
  'account_update:ACCOUNT_RESTRICTION': {
    title: 'Account restricted',
    message: 'Meta restricts this account ({{kinds|label}})[ until {{until}}]. Template messages are refused meanwhile; replies in a chat still go.',
    severity: 'critical',
    raise: { cause: 'restriction', blocks: 'blocked', action: 'Open WhatsApp Manager to see the restriction and what lifts it.', link: 'manager' },
  },
  'account_update:ACCOUNT_RESTRICTION:OTHER': { title: 'Account restricted', message: 'Meta restricts this account ({{kinds|label}})[ until {{until}}].', severity: 'critical' },
  'account_update:ACCOUNT_RESTRICTION:LIFTED': { title: 'Restriction lifted', message: 'Meta has lifted the restriction on this account.', clear: 'restriction' },
  'account_update:ACCOUNT_VIOLATION': {
    title: 'Policy violation reported',
    message: 'Meta says the account violated its policies ({{violation_info.violation_type|label}}). Restrictions may follow.',
    severity: 'critical',
  },
  'account_update:ACCOUNT_DELETED': {
    title: 'Account deleted',
    message: 'The WhatsApp Business Account was deleted, so nothing can be sent.',
    severity: 'critical',
    raise: { cause: 'ban', blocks: 'disabled', action: 'Onboard the number again if you still need it.', link: 'reconnect' },
  },
  'account_update:DISCONNECTED': {
    title: 'Number disconnected',
    message: 'The number was disconnected from Watobot[ ({{disconnection_info.reason|label}}, started by {{disconnection_info.initiated_by|label}})], so nothing can be sent.',
    severity: 'critical',
    raise: { cause: 'connection', blocks: 'disabled', action: DISCONNECT_ACTION, link: 'reconnect' },
  },
  'account_update:UNINSTALLED': {
    title: 'Number disconnected',
    message: "The account's owner removed Watobot's access, so nothing can be sent.",
    severity: 'critical',
    raise: { cause: 'connection', blocks: 'disabled', action: DISCONNECT_ACTION, link: 'reconnect' },
  },
  'account_update:CONNECTED': CONNECTED,
  // Any other account update is a notification and gates nothing.
  account_update: { title: 'Account update: {{event|label}}', message: 'Meta reported a change to the account. It does not affect sending.' },

  'account_review_update:APPROVED': { title: 'Account approved', message: "Meta's review of the account is approved.", clear: 'review' },
  account_review_update: {
    title: 'Account review: {{decision|label}}',
    message: "Meta's review of the account is {{decision|label}}, and until it is approved the account cannot be used with the API.",
    severity: 'critical',
    raise: { cause: 'review', blocks: 'disabled', action: 'Open WhatsApp Manager and Business Support to see what Meta needs.', link: 'manager' },
  },

  'phone_number_name_update:APPROVED': {
    title: 'Display name approved',
    message: 'Meta approved the display name "{{requested_verified_name}}".',
    name: { name: '{{requested_verified_name}}', status: 'APPROVED', requestedName: null, requestedStatus: 'NONE' },
    clear: 'name',
  },
  'phone_number_name_update:REJECTED': {
    title: 'Display name declined',
    message: 'Meta declined the display name "{{requested_verified_name}}"[ ({{rejection_reason|label}})].',
    severity: 'warning',
    name: { requestedName: '{{requested_verified_name}}', requestedStatus: 'DECLINED' },
    raise: { cause: 'name', chip: 'name', scope: 'PHONE_NUMBER', blocks: 'info', keepWorse: true, action: 'Request a different name that follows the guidelines.', link: 'names' },
  },
  phone_number_name_update: {
    title: 'Display name in review',
    message: 'Meta is still reviewing the display name "{{requested_verified_name}}".',
    name: { requestedName: '{{requested_verified_name}}', requestedStatus: 'PENDING_REVIEW' },
    raise: { cause: 'name', chip: 'name', scope: 'PHONE_NUMBER', blocks: 'info', keepWorse: true, action: "Wait for Meta's decision. Don't submit another name until it arrives.", link: 'names' },
  },

  'phone_number_quality_update:FLAGGED': {
    title: 'Number update: flagged',
    message: 'Meta reported flagged[; the messaging limit is now {{tierName}}].',
    severity: 'warning',
    tier: true,
    raise: {
      cause: 'quality',
      scope: 'PHONE_NUMBER',
      blocks: 'limited',
      message: 'Meta flagged this number because of how its messages are received. Watobot allows only {{limitedDaily}} template messages a day until it clears.',
      action: 'Pause campaigns, send only to people who asked for them, and review your templates. Then refresh.',
      link: 'manager',
    },
  },
  'phone_number_quality_update:UNFLAGGED': { title: 'Number update: unflagged', message: 'Meta reported unflagged[; the messaging limit is now {{tierName}}].', tier: true, clear: 'quality' },
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
    title: 'Template {{status|label}}',
    message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})]. It is not sent until it is fixed or reinstated.',
    severity: 'warning',
    template: 'problem',
  },
  'message_template_status_update:RECOVERED': {
    title: 'Template {{status|label}}',
    message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})].',
    template: 'recover',
  },
  message_template_status_update: {
    title: 'Template {{status|label}}',
    message: 'The template "{{message_template_name}}" ({{message_template_language}}) is {{status|label}}[ ({{reason|label}})].',
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

/** Meta's tier names are TIER_250, TIER_2K ...; TIER_NOT_SET and anything else is not a limit. */
const asTier = (value: unknown) => (typeof value === 'string' && /^TIER_(\d+K?|UNLIMITED)$/.test(value) ? value : undefined);
const tierVars = (tier: string | undefined) => (tier ? { tier, tierName: tier.replace('TIER_', '') } : {});
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
