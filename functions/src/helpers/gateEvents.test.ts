import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEffects, parseWebhook } from './gateEvents';
import { statusOf } from './gates';

const hook = (field: string, value: object, time = 1_700_000_000) => ({ object: 'whatsapp_business_account', entry: [{ id: '123', time, changes: [{ field, value }] }] });
const one = (field: string, value: object, time?: number) => parseWebhook(hook(field, value, time))[0];
const NOW = 1_700_000_100_000;

test('payloads from Meta\'s docs become events with the right wording and effect', () => {
  const ban = one('account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: ['SCHEDULE_FOR_DISABLE', 'DISABLE'], waba_ban_date: 'DATE' } });
  assert.equal(ban.wabaId, '123');
  assert.equal(ban.eventAt, 1_700_000_000_000);
  assert.equal(ban.notification.severity, 'critical');
  assert.equal(ban.effects[0].kind === 'raise' && ban.effects[0].reason.severity, 'disabled');
  assert.equal(one('account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }).effects[0].kind, 'clear');

  const restriction = one('account_update', { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1_800_000_000 }, { restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION', expiration: 1_800_000_000 }] });
  const raised = restriction.effects[0];
  assert.ok(raised.kind === 'raise' && raised.reason.until === 1_800_000_000_000 && raised.reason.severity === 'blocked');

  assert.equal(one('account_update', { event: 'PARTNER_REMOVED', disconnection_info: { reason: 'COMPANION_INACTIVITY', initiated_by: 'SYSTEM' } }).effects[0].kind, 'raise');
  assert.equal(one('account_update', { event: 'ACCOUNT_RECONNECTED' }).effects[0].kind, 'clear');
  assert.deepEqual(one('account_update', { event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE' }).effects, [], 'an update that does not bear on sending only becomes a notification');

  assert.equal(one('account_review_update', { decision: 'REJECTED' }).effects[0].kind, 'raise');
  assert.equal(one('account_review_update', { decision: 'APPROVED' }).effects[0].kind, 'clear');

  const tier = one('phone_number_quality_update', { display_phone_number: '124545784358810', event: 'FLAGGED', current_limit: 'TIER_10K' });
  assert.deepEqual(tier.effects.map((e) => e.kind), ['tier', 'raise']);
  assert.equal(tier.displayPhone, '124545784358810');
  assert.deepEqual(one('business_capability_update', { max_daily_conversations_per_business: 'TIER_2K' }).effects, [{ kind: 'tier', tier: 'TIER_2K' }]);
  assert.deepEqual(one('phone_number_quality_update', { event: 'ONBOARDING', current_limit: 'TIER_NOT_SET' }).effects, []);

  assert.equal(one('phone_number_name_update', { display_phone_number: '1', decision: 'APPROVED', requested_verified_name: 'Shop', rejection_reason: null }).effects.length, 2);
  assert.equal(one('account_alerts', { entity_type: 'BUSINESS', alert_info: { alert_severity: 'CRITICAL', alert_type: 'LIMIT_NOT_INCREASED', alert_description: 'Limits cannot be increased' } }).notification.severity, 'critical');
});

test('template events: trouble is a gate, recovery removes it, quality only a notification, and the field name is not trusted for quality', () => {
  const paused = one('message_template_status_update', { event: 'PAUSED', message_template_id: 1, message_template_name: 'hello', message_template_language: 'en-US', reason: 'NONE', other_info: { title: 'FIRST_PAUSE' } });
  assert.deepEqual(paused.effects, [{ kind: 'template', key: 'hello|en_US', gate: { status: 'PAUSED', reason: undefined, at: 1_700_000_000_000 } }]);
  assert.deepEqual(one('message_template_status_update', { event: 'REINSTATED', message_template_name: 'hello', message_template_language: 'en_US' }).effects, [{ kind: 'template', key: 'hello|en_US', gate: null }]);
  assert.deepEqual(one('message_template_status_update', { event: 'FLAGGED', message_template_name: 'hello', message_template_language: 'en_US' }).effects, []);
  const quality = one('message_template_status_update', { previous_quality_score: 'GREEN', new_quality_score: 'RED', message_template_id: 1, message_template_name: 'hello', message_template_language: 'en-US' });
  assert.equal(quality.event, 'QUALITY');
  assert.equal(quality.notification.severity, 'warning');
  assert.deepEqual(quality.effects, []);
});

test('messages, syncs and echoes are never turned into events, so they are never kept', () => {
  for (const field of ['messages', 'history', 'smb_message_echoes', 'smb_app_state_sync', 'calls', 'flows', 'user_preferences', 'group_participants_update']) {
    assert.deepEqual(parseWebhook(hook(field, { messages: [{ text: { body: 'secret' } }] })), []);
  }
  assert.deepEqual(parseWebhook({}), []);
  assert.deepEqual(parseWebhook({ entry: [{ changes: [{ field: 'account_update', value: { event: 'ACCOUNT_DELETED' } }] }] }), [], 'an entry with no account id');
});

test('applying events: a ban then its lifting, order, the name decision and the tier', () => {
  let doc: any = {};
  const apply = (event: ReturnType<typeof one>) => {
    const patch = applyEffects(doc, event.effects, event.eventAt, NOW);
    if (patch) doc = { ...doc, ...patch };
    return patch;
  };
  apply(one('account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }, 1_700_000_010));
  assert.equal(statusOf(doc.health.reasons, NOW), 'disabled');
  assert.equal(apply(one('account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }, 1_700_000_005)), null, 'a lifting older than the ban is ignored');
  apply(one('account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }, 1_700_000_020));
  assert.equal(statusOf(doc.health.reasons, NOW), 'ok');

  apply(one('phone_number_quality_update', { event: 'UPGRADE', current_limit: 'TIER_2K' }));
  assert.equal(doc.health.tier, 'TIER_2K');

  // A limited number whose name is declined stays limited; the approval lifts it.
  doc.health = { status: 'limited', tier: 'TIER_250', reasons: [{ chip: 'name', cause: 'name', severity: 'limited', title: 't', message: 'm', action: 'a', scope: 'PHONE_NUMBER', at: 1 }] };
  apply(one('phone_number_name_update', { decision: 'REJECTED', requested_verified_name: 'Shop', rejection_reason: 'NAME_EMPLOYEE_ISSUE' }, 1_700_000_030));
  assert.equal(statusOf(doc.health.reasons, NOW), 'limited', 'a declined name does not lift the cap');
  assert.equal(doc.displayName.requestedStatus, 'DECLINED');
  apply(one('phone_number_name_update', { decision: 'APPROVED', requested_verified_name: 'Shop' }, 1_700_000_040));
  assert.equal(statusOf(doc.health.reasons, NOW), 'ok');
  assert.equal(doc.displayName.status, 'APPROVED');

  apply(one('message_template_status_update', { event: 'DISABLED', message_template_name: 'x', message_template_language: 'en_US' }, 1_700_000_050));
  assert.deepEqual(Object.keys(doc.templates), ['x|en_US']);
  apply(one('message_template_status_update', { event: 'REINSTATED', message_template_name: 'x', message_template_language: 'en_US' }, 1_700_000_060));
  assert.deepEqual(doc.templates, {});
});

test('every other account-level field is kept as a notification that gates nothing, whether or not we know it', () => {
  const event = one('business_status_update', { event: 'VERIFIED', business_id: 77, detail: { nested: true } });
  assert.equal(event.notification.title, 'Meta reported: business status update');
  assert.match(event.notification.message, /event: VERIFIED/);
  assert.deepEqual(event.effects, []);
  assert.equal(one('account_settings_update', {}).notification.message, 'Meta sent an update with no simple fields.');
  assert.equal(one('some_field_meta_adds_next_year', { a: 1 }).notification.title, 'Meta reported: some field meta adds next year');
});
