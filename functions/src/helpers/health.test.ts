import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealth, effectiveConfigFor, nextRefreshAt, reasonsFromRefusal, REFRESH_MIN_INTERVAL_MS, templateGateFromRefusal, tierLimit } from './health';
import type { MetaSnapshot, NumberHealth } from './types';

const NOW = 1_000_000;
const snapshot = (phone: Record<string, unknown>, tier?: string, waba?: Record<string, unknown>): Pick<MetaSnapshot, 'phone' | 'messagingLimit' | 'waba'> => ({
  phone: { ok: true, data: phone },
  messagingLimit: tier ? { ok: true, data: tier } : { ok: false, error: 'x' },
  waba: waba ? { ok: true, data: waba } : { ok: false, error: 'x' },
});
const sip = { error_code: 138024, error_description: 'WhatsApp Business calling cannot use SIP because it is not enabled' };
const unverified = { entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010, error_description: 'not verified' }] };

test('a blocked account blocks, with our own words and cause for the payment problem, and calling errors are left out', () => {
  const derived = deriveHealth(
    snapshot({
      verified_name: 'Shop', name_status: 'APPROVED',
      health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE', errors: [sip] }, { entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'payment', possible_solution: 'add one' }] }] },
    }, 'TIER_250'), NOW,
  )!;
  assert.equal(derived.health.status, 'blocked');
  assert.equal(derived.health.tier, 'TIER_250');
  const [reason] = derived.health.reasons;
  assert.equal(derived.health.reasons.length, 1);
  assert.equal(reason.title, 'Payment method problem');
  assert.equal(reason.cause, 'payment');
  assert.equal(reason.at, NOW);
  assert.ok(reason.link?.startsWith('https://business.facebook.com/'));
  assert.equal(derived.displayName.name, 'Shop');
});

test('only the number being limited limits it, and the unverified business gets its own chip without changing the status', () => {
  const limited = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet.'] }, unverified] } }), NOW)!;
  assert.equal(limited.health.status, 'limited');
  assert.deepEqual(limited.health.reasons.map((r) => r.chip).sort(), ['business', 'name']);
  assert.equal(limited.health.businessVerified, false);

  const only = deriveHealth(snapshot({ health_status: { entities: [unverified] } }), NOW)!;
  assert.equal(only.health.status, 'ok');
  assert.deepEqual(only.health.reasons.map((r) => [r.chip, r.severity]), [['business', 'info']]);
});

test('the account review, the number\'s own status and red quality each gate sending, and yellow only warns', () => {
  const rejected = deriveHealth(snapshot({ health_status: { entities: [] } }, undefined, { account_review_status: 'REJECTED', business_verification_status: 'verified' }), NOW)!;
  assert.equal(rejected.health.status, 'disabled');
  assert.equal(rejected.health.reasons[0].cause, 'review');
  assert.equal(rejected.health.businessVerified, true);

  assert.equal(deriveHealth(snapshot({ status: 'BANNED', health_status: { entities: [] } }), NOW)!.health.status, 'disabled');
  assert.equal(deriveHealth(snapshot({ status: 'RESTRICTED', health_status: { entities: [] } }), NOW)!.health.status, 'blocked');
  assert.equal(deriveHealth(snapshot({ status: 'CONNECTED', quality_rating: 'RED', health_status: { entities: [] } }), NOW)!.health.status, 'limited');
  assert.equal(deriveHealth(snapshot({ quality_rating: 'YELLOW', health_status: { entities: [] } }), NOW)!.health.status, 'ok');
  assert.equal(deriveHealth(snapshot({ status: 'CONNECTED', health_status: { entities: [] } }, undefined, { account_review_status: 'APPROVED' }), NOW)!.health.reasons.length, 0);
});

test('a name in review, a declined name and an unknown Meta error are passed on in the right words', () => {
  const review = deriveHealth(snapshot({ new_name_status: 'PENDING_REVIEW', new_display_name: 'Shop 2', health_status: { entities: [] } }), NOW)!;
  assert.deepEqual(review.health.reasons.map((r) => r.title), ['Display name in review']);
  assert.equal(deriveHealth(snapshot({ name_status: 'DECLINED', health_status: { entities: [] } }), NOW)!.health.reasons[0].title, 'Display name declined');

  const other = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 999999, error_description: 'something new', possible_solution: 'do this' }] }] } }), NOW)!;
  assert.equal(other.health.reasons[0].message, 'something new');
  assert.equal(other.health.reasons[0].action, 'do this');
});

test('blocked with no reason from Meta still says something, and a read without a status gives none', () => {
  const both = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED' }, { entity_type: 'WABA', can_send_message: 'BLOCKED' }] } }), NOW)!;
  assert.equal(both.health.status, 'blocked');
  assert.ok(both.health.reasons.length >= 2);
  assert.equal(deriveHealth({ phone: { ok: false, error: 'x' }, messagingLimit: { ok: false, error: 'x' } }, NOW), null);
  assert.equal(deriveHealth(snapshot({ status: 'CONNECTED' }), NOW), null);
});

test('refusals: payment and lock are remembered, spam rate limit pauses for an hour, a paused template is named', () => {
  assert.equal(reasonsFromRefusal({ code: 131042, message: 'payment' }, NOW)[0].cause, 'payment');
  assert.equal(reasonsFromRefusal({ code: 131031 }, NOW)[0].severity, 'disabled');
  const spam = reasonsFromRefusal({ code: 131048, message: 'spam' }, NOW)[0];
  assert.equal(spam.cause, 'cooldown');
  assert.equal(spam.until, NOW + 60 * 60 * 1000);
  assert.deepEqual(reasonsFromRefusal({ code: 131049 }, NOW), [], 'the per-recipient marketing limit says nothing about the number');
  assert.deepEqual(reasonsFromRefusal({ code: 130429 }, NOW), [], 'throughput is a rate the sender backs off from');
  assert.equal(templateGateFromRefusal({ code: 132015 }, 'hello|en_US', NOW)?.gate.status, 'PAUSED');
  assert.equal(templateGateFromRefusal({ code: 132016 }, 'hello|en_US', NOW)?.gate.status, 'DISABLED');
  assert.equal(templateGateFromRefusal({ code: 132015 }, undefined, NOW), null);
});

test('the daily limit never goes above Meta\'s tier, and a limited number gets five at most', () => {
  assert.equal(tierLimit('TIER_250'), 250);
  assert.equal(tierLimit('TIER_1K'), 1000);
  assert.equal(tierLimit('TIER_UNLIMITED'), undefined);
  const health = (extra: Partial<NumberHealth>): NumberHealth => ({ status: 'ok', reasons: [], ...extra });
  const limitedReason = { chip: 'status' as const, cause: 'limited' as const, title: 't', message: 'm', action: 'a', scope: 'PHONE_NUMBER', severity: 'limited' as const, at: 1 };
  assert.equal(effectiveConfigFor({}, NOW).day.max, undefined);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_250' }) }, NOW).day.max, 250);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_250', status: 'limited', reasons: [limitedReason] }) }, NOW).day.max, 5);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_250', status: 'limited', reasons: [{ ...limitedReason, until: NOW - 1 }] }) }, NOW).day.max, 250, 'a limit that has ended no longer caps');
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_10K' }), rateLimits: { day: { max: 300 } } }, NOW).day.max, 300);
});

test('Meta is not asked again within ten minutes of the last read', () => {
  assert.equal(nextRefreshAt(undefined, 1000), 1000);
  assert.equal(nextRefreshAt(1000, 2000), 1000 + REFRESH_MIN_INTERVAL_MS);
  assert.equal(nextRefreshAt(1000, 1000 + REFRESH_MIN_INTERVAL_MS + 5), 1000 + REFRESH_MIN_INTERVAL_MS + 5);
});
