import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserve, type Limits } from './rateLimiter';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 30);
const send = (limits: Limits | undefined, caps: Limits = {}, count = 1) => {
  let state;
  let last;
  for (let i = 0; i < count; i++) {
    last = reserve(state, limits, caps, NOW);
    state = last.state;
  }
  return last!;
};

test('a new number starts at the floors, and a refused request never raises the limit', () => {
  assert.equal(send(undefined, {}, 10).allowed, true);
  const refused = send(undefined, {}, 11);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed ? 0 : refused.limit, 10);
  assert.equal(refused.earned.minute, 10);
});

test('a number moved over with higher limits sends at once, and the ceiling from its health still caps it', () => {
  assert.equal(send({ minute: 100, hour: 500, day: 2000 }, {}, 50).allowed, true);
  const capped = send({ minute: 100, hour: 500, day: 2000 }, { day: 5 }, 6);
  assert.equal(capped.allowed, false);
  assert.equal(capped.allowed ? 0 : capped.limit, 5);
});
