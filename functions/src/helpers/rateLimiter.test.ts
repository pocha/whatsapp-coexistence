import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, effectiveConfig, limitFor, reserve, type RateState } from './rateLimiter';
import { DEFAULT_RATE_LIMITS } from './rateLimitConfig';

const T0 = Date.UTC(2026, 9, 14, 9, 15, 30); // 09:15:30 UTC

test('a quiet number may always send up to the floor, then is refused', () => {
  let state: RateState | undefined;
  for (let i = 0; i < DEFAULT_RATE_LIMITS.minute.floor; i += 1) {
    const verdict = reserve(state, DEFAULT_RATE_LIMITS, T0);
    assert.equal(verdict.allowed, true);
    state = verdict.state;
  }
  const refused = reserve(state, DEFAULT_RATE_LIMITS, T0);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.unit, 'minute');
});

test('the limit grows with the previous window, plus headroom for ordinary scatter', () => {
  // previous 100 in a minute at 5%: 105 + 3 × √100 = 135
  assert.equal(limitFor(100, DEFAULT_RATE_LIMITS.minute, 3), 135);
  // an empty previous window falls back to the floor
  assert.equal(limitFor(0, DEFAULT_RATE_LIMITS.minute, 3), 10);
});

test('windows roll: next window keeps the count as previous, a gap clears it', () => {
  const state: RateState = {
    lastAt: T0,
    minute: { current: 7, previous: 2 },
    hour: { current: 20, previous: 4 },
    day: { current: 30, previous: 9 },
  };
  const nextMinute = advance(state, T0 + 60_000);
  assert.deepEqual(nextMinute.minute, { current: 0, previous: 7 });
  assert.deepEqual(nextMinute.hour, { current: 20, previous: 4 }); // same hour
  const longGap = advance(state, T0 + 3 * 86_400_000);
  assert.deepEqual(longGap.day, { current: 0, previous: 0 });
});

test('a per-number override changes only what it names', () => {
  const config = effectiveConfig({ minute: { floor: 40 }, enabled: true });
  assert.equal(config.minute.floor, 40);
  assert.equal(config.minute.growthPercent, DEFAULT_RATE_LIMITS.minute.growthPercent);
  assert.equal(config.hour.floor, DEFAULT_RATE_LIMITS.hour.floor);
});
