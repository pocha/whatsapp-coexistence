import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealth, effectiveConfigFor, healthFromRefusal, nextRefreshAt, REFRESH_MIN_INTERVAL_MS, tierLimit } from './health';
import type { MetaSnapshot, NumberHealth } from './types';

const snapshot = (phone: Record<string, unknown>, tier?: string): Pick<MetaSnapshot, 'phone' | 'messagingLimit'> => ({
  phone: { ok: true, data: phone },
  messagingLimit: tier ? { ok: true, data: tier } : { ok: false, error: 'x' },
});
const sip = { error_code: 138024, error_description: 'WhatsApp Business calling cannot use SIP because it is not enabled' };
const unverified = { entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010, error_description: 'not verified' }] };

test('a blocked account blocks, with our own words for the payment problem, and calling errors are left out', () => {
  const derived = deriveHealth(
    snapshot({
      verified_name: 'Shop',
      name_status: 'APPROVED',
      health_status: {
        entities: [
          { entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE', errors: [sip] },
          { entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'payment', possible_solution: 'add one' }] },
        ],
      },
    }, 'TIER_250'),
  )!;
  assert.equal(derived.health.status, 'blocked');
  assert.equal(derived.health.tier, 'TIER_250');
  assert.equal(derived.health.reasons.length, 1);
  const [reason] = derived.health.reasons;
  assert.equal(reason.title, 'Payment method problem');
  assert.equal(reason.chip, 'status');
  assert.match(reason.action, /payment method/);
  assert.ok(reason.link?.startsWith('https://business.facebook.com/'));
  assert.equal(derived.displayName.name, 'Shop');
});

test('only the number being limited limits it, and the unverified business gets its own chip without changing the status', () => {
  const limited = deriveHealth(
    snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet.'] }, unverified] } }),
  )!;
  assert.equal(limited.health.status, 'limited');
  assert.deepEqual(limited.health.reasons.map((r) => r.chip).sort(), ['business', 'name']);

  const onlyUnverified = deriveHealth(snapshot({ health_status: { entities: [unverified] } }))!;
  assert.equal(onlyUnverified.health.status, 'ok');
  assert.deepEqual(onlyUnverified.health.reasons.map((r) => [r.chip, r.severity]), [['business', 'info']]);
});

test('a name in review, a declined name and low quality are shown, and an unknown Meta error is passed on in Meta\'s words', () => {
  const review = deriveHealth(snapshot({ new_name_status: 'PENDING_REVIEW', new_display_name: 'Shop 2', health_status: { entities: [] } }))!;
  assert.deepEqual(review.health.reasons.map((r) => r.title), ['Display name in review']);
  assert.equal(review.health.status, 'ok');

  const declined = deriveHealth(snapshot({ name_status: 'DECLINED', health_status: { entities: [] } }))!;
  assert.equal(declined.health.reasons[0].title, 'Display name declined');

  const quality = deriveHealth(snapshot({ quality_rating: 'RED', health_status: { entities: [] } }))!;
  assert.equal(quality.health.reasons[0].title, 'Message quality is low');

  const other = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 999999, error_description: 'something new', possible_solution: 'do this' }] }] } }))!;
  assert.equal(other.health.reasons[0].message, 'something new');
  assert.equal(other.health.reasons[0].action, 'do this');
});

test('blocked wins over limited, a read without a status gives none, and fields Meta left out are not an error', () => {
  const both = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED' }, { entity_type: 'WABA', can_send_message: 'BLOCKED' }] } }))!;
  assert.equal(both.health.status, 'blocked');
  assert.ok(both.health.reasons.length > 0, 'a blocked number always says something');
  assert.equal(deriveHealth({ phone: { ok: false, error: 'x' }, messagingLimit: { ok: false, error: 'x' } }), null);
  assert.equal(deriveHealth(snapshot({ status: 'CONNECTED' })), null);
  assert.equal(deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006 }] }] } }))!.displayName.name, undefined);
});

test('only a refusal that says the account cannot send becomes a status', () => {
  assert.equal(healthFromRefusal({ code: 131042, message: 'payment' })?.status, 'blocked');
  assert.equal(healthFromRefusal({ code: 131026, message: 'undeliverable' }), null);
  assert.equal(healthFromRefusal(undefined), null);
});

test('the daily limit never goes above Meta\'s tier, and a limited number gets five at most', () => {
  assert.equal(tierLimit('TIER_250'), 250);
  assert.equal(tierLimit('TIER_1K'), 1000);
  assert.equal(tierLimit('TIER_UNLIMITED'), undefined);
  const health = (extra: Partial<NumberHealth>): NumberHealth => ({ status: 'ok', reasons: [], ...extra });
  assert.equal(effectiveConfigFor({}).day.max, undefined);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_250' }) }).day.max, 250);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_250', status: 'limited' }) }).day.max, 5);
  assert.equal(effectiveConfigFor({ health: health({ tier: 'TIER_10K' }), rateLimits: { day: { max: 300 } } }).day.max, 300);
});

test('Meta is not asked again within ten minutes of the last read', () => {
  assert.equal(nextRefreshAt(undefined, 1000), 1000);
  assert.equal(nextRefreshAt(1000, 2000), 1000 + REFRESH_MIN_INTERVAL_MS);
  assert.equal(nextRefreshAt(1000, 1000 + REFRESH_MIN_INTERVAL_MS + 5), 1000 + REFRESH_MIN_INTERVAL_MS + 5);
});
