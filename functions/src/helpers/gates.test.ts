import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clear, mergeRefresh, raise, sendDecision, statusOf, templateKey } from './gates';
import type { HealthReason, NumberHealth } from './types';

const reason = (cause: HealthReason['cause'], severity: HealthReason['severity'], at: number, extra: Partial<HealthReason> = {}): HealthReason => ({
  chip: 'status', cause, severity, at, title: cause, message: cause, action: 'fix', scope: 'WABA', ...extra,
});
const health = (reasons: HealthReason[], now = 100): NumberHealth => ({ status: statusOf(reasons, now), reasons });

test('the worst active reason is the status, and one with an end time stops counting after it', () => {
  assert.equal(statusOf([], 1), 'ok');
  assert.equal(statusOf([reason('payment', 'blocked', 1), reason('quality', 'limited', 1)], 5), 'blocked');
  assert.equal(statusOf([reason('ban', 'disabled', 1), reason('payment', 'blocked', 1)], 5), 'disabled');
  assert.equal(statusOf([reason('restriction', 'blocked', 1, { until: 50 })], 49), 'blocked');
  assert.equal(statusOf([reason('restriction', 'blocked', 1, { until: 50 })], 50), 'ok');
});

test('a notification sets only its own cause, a lifted ban leaves a payment problem, and an older one is ignored', () => {
  let h: NumberHealth | undefined = health([reason('payment', 'blocked', 10)]);
  h = raise(h, reason('ban', 'disabled', 20), 100)!;
  assert.equal(h.status, 'disabled');
  h = clear(h, 'ban', 30, 100)!;
  assert.equal(h.status, 'blocked', 'the payment problem is still there');
  assert.deepEqual(h.reasons.map((r) => r.cause), ['payment']);
  assert.equal(clear(h, 'ban', 40, 100), null, 'nothing of that cause to clear');
  assert.equal(raise(h, reason('payment', 'info', 5), 100), null, 'older than what is stored for that cause');
  assert.equal(clear(h, 'payment', 5, 100), null, 'an older "all clear" does not lift a newer problem');
});

test('a refresh replaces the reasons, but keeps one that arrived while it ran', () => {
  const stored = health([reason('ban', 'disabled', 10), reason('restriction', 'blocked', 95)]);
  const derived = { status: 'ok' as const, reasons: [], tier: 'TIER_250', businessVerified: false };
  const merged = mergeRefresh(stored, derived, 90, 100);
  assert.deepEqual(merged.reasons.map((r) => r.cause), ['restriction'], 'the ban is gone (Meta says fine), the newer restriction stays');
  assert.equal(merged.status, 'blocked');
  assert.equal(merged.tier, 'TIER_250');
  assert.equal(merged.businessVerified, false);
});

const template = { type: 'template', template: { name: 'hello', language: { code: 'en_US' } } };
const text = { type: 'text', text: { body: 'hi' } };

test('what is stored decides whether a message goes out', () => {
  assert.equal(sendDecision({}, template, 100).allow, true, 'nothing stored, nothing held back');

  const disabled = sendDecision({ health: health([reason('ban', 'disabled', 1)]) }, text, 100);
  assert.equal(disabled.allow, false, 'a disabled number sends nothing, not even a reply');

  const blocked = { health: health([reason('payment', 'blocked', 1)]) };
  assert.equal(sendDecision(blocked, text, 100).allow, true, 'a blocked number can still reply');
  const refused = sendDecision(blocked, template, 100);
  assert.ok(!refused.allow && refused.httpStatus === 403 && refused.reasons[0].cause === 'payment');

  const paused = sendDecision({ health: health([reason('cooldown', 'blocked', 1, { until: 100 + 3600_000 })]) }, template, 100);
  assert.ok(!paused.allow && paused.httpStatus === 429 && paused.retryAfterSeconds === 3600, 'a pause with an end is a 429 with Retry-After');
  assert.equal(sendDecision({ health: health([reason('cooldown', 'blocked', 1, { until: 100 })]) }, template, 100).allow, true, 'and it lifts by itself');

  const limited = sendDecision({ health: health([reason('limited', 'limited', 1)]) }, template, 100);
  assert.equal(limited.allow, true, 'the cap for a limited number is the rate limit\'s business');
});

test('a paused template is refused by name and language and nothing else is', () => {
  const doc = { templates: { 'hello|en_US': { status: 'PAUSED', at: 1, reason: 'NONE' } } };
  const refused = sendDecision(doc, template, 100);
  assert.ok(!refused.allow && refused.status === 'template' && /hello/.test(refused.error));
  assert.equal(sendDecision(doc, { type: 'template', template: { name: 'other', language: { code: 'en_US' } } }, 100).allow, true);
  assert.equal(sendDecision(doc, text, 100).allow, true);
  assert.equal(templateKey({ template: { name: 'a', language: { code: 'en-US' } } }), 'a|en_US', 'en-US and en_US are the same language');
});
