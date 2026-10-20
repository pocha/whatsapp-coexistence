import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, allowance, DEFAULT_RATE_LIMITS as CONFIG, effectiveConfig, reserve, type Limits, type RateState } from './rateLimiter';

const T0 = Date.UTC(2026, 9, 14, 9, 15, 30); // 09:15:30 UTC
const NONE: Limits = {};

test('refused requests are counted as attempts but never raise the limit', () => {
  let state: RateState | undefined;
  for (let i = 0; i < 25; i += 1) state = reserve(state, undefined, NONE, CONFIG, T0).state; // floor is 10
  assert.equal(state!.minute.current, 10);
  assert.equal(state!.minute.currentAttempts, 25);

  // Next minute: the limit comes from the 10 accepted, not the 25 attempted.
  const next = advance(state, T0 + 60_000);
  assert.deepEqual([next.minute.previous, next.minute.previousAttempts], [10, 25]);
  // 10 × 1.05 + 3 × √10 = 19.99. Had the 25 attempts counted it would be 26 + 15 = 41.
  assert.equal(allowance('minute', next.minute.previous, undefined, NONE, CONFIG).limit, 19);
});

test('a quiet number may always send up to the floor, then is refused', () => {
  let state: RateState | undefined;
  for (let i = 0; i < 10; i += 1) {
    const verdict = reserve(state, undefined, NONE, CONFIG, T0);
    assert.equal(verdict.allowed, true);
    state = verdict.state;
  }
  const refused = reserve(state, undefined, NONE, CONFIG, T0);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.unit, 'minute');
});

test('the limit grows with the previous window, plus headroom for ordinary scatter', () => {
  // previous 100 in a minute at 5%: 105 + 3 × √100 = 135
  assert.equal(allowance('minute', 100, undefined, NONE, CONFIG).limit, 135);
  // an empty previous window falls back to the floor
  assert.equal(allowance('minute', 0, undefined, NONE, CONFIG).limit, 10);
});

test('windows roll: next window keeps the count as previous, a gap clears it', () => {
  const state: RateState = {
    lastAt: T0,
    minute: { current: 7, previous: 2, currentAttempts: 9, previousAttempts: 3 },
    hour: { current: 20, previous: 4, currentAttempts: 20, previousAttempts: 4 },
    day: { current: 30, previous: 9, currentAttempts: 30, previousAttempts: 9 },
  };
  const nextMinute = advance(state, T0 + 60_000);
  assert.deepEqual(nextMinute.minute, { current: 0, previous: 7, currentAttempts: 0, previousAttempts: 9 });
  assert.deepEqual(nextMinute.hour, state.hour); // same hour
  const longGap = advance(state, T0 + 3 * 86_400_000);
  assert.deepEqual(longGap.day, { current: 0, previous: 0, currentAttempts: 0, previousAttempts: 0 });
});

test('a number moved over with higher limits sends at once and keeps what it earned, and the ceiling from its health still caps it', () => {
  const moved: Limits = { minute: 100, hour: 500, day: 2000 };
  assert.equal(allowance('day', 0, moved, NONE, CONFIG).limit, 2000);
  assert.equal(allowance('day', 0, moved, { day: 5 }, CONFIG).limit, 5, 'the ceiling wins');
  assert.equal(allowance('day', 0, moved, { day: 5 }, CONFIG).earned, 2000, 'what was earned is kept for when the ceiling lifts');
  // it only grows: a quiet day does not lower it
  assert.equal(reserve(undefined, moved, NONE, CONFIG, T0).earned.day, 2000);
});

test('a per-number override changes only what it names', () => {
  const config = effectiveConfig({ minute: { floor: 40 }, enabled: true });
  assert.equal(config.minute.floor, 40);
  assert.equal(config.minute.growthPercent, CONFIG.minute.growthPercent);
  assert.equal(config.hour.floor, CONFIG.hour.floor);
  assert.equal(allowance('minute', 0, undefined, NONE, config).limit, 40);
});
