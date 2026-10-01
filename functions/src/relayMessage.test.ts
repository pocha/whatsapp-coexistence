import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyKey, isoWeekKey, monthlyKey } from './relayMessage';

// ISO week numbers below are cross-checked independently via `date -j -f
// "%Y-%m-%d" <date> "+%G-W%V"` (macOS BSD date's own ISO-8601 week
// implementation), not derived from the algorithm under test.

test('dailyKey formats as YYYY-MM-DD (UTC)', () => {
  assert.equal(dailyKey(new Date('2026-09-29T23:00:00Z')), '2026-09-29');
});

test('monthlyKey formats as YYYY-MM (UTC)', () => {
  assert.equal(monthlyKey(new Date('2026-09-29T23:00:00Z')), '2026-09');
});

test('isoWeekKey matches an ordinary mid-year date', () => {
  assert.equal(isoWeekKey(new Date('2026-09-29T12:00:00Z')), '2026-W40');
});

test('isoWeekKey matches the first day of a year that starts mid-week', () => {
  assert.equal(isoWeekKey(new Date('2026-01-01T12:00:00Z')), '2026-W01');
});

test('isoWeekKey handles the year-boundary edge case (Dec 31 landing in next year\'s week 1)', () => {
  assert.equal(isoWeekKey(new Date('2025-12-31T12:00:00Z')), '2026-W01');
});
