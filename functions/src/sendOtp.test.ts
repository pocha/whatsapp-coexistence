import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, sendOtpCore } from './sendOtp';

test('normalizePhone strips non-digits and rejects out-of-range lengths', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('1'.repeat(16)), null);
  assert.equal(normalizePhone(undefined), null);
});

function makeDeps(overrides: Partial<Parameters<typeof sendOtpCore>[1]> = {}) {
  const sent: { phone: string; message: string }[] = [];
  const stored: Record<string, { code: string; expiresAt: number; attempts: number; lastSentAt: number }> = {};
  return {
    sent,
    stored,
    deps: {
      getOtpDoc: async (phone: string) => stored[phone],
      setOtpDoc: async (phone: string, data: { code: string; expiresAt: number; attempts: number; lastSentAt: number }) => {
        stored[phone] = data;
      },
      sendMessage: async (phone: string, message: string) => {
        sent.push({ phone, message });
      },
      ...overrides,
    },
  };
}

test('sendOtpCore rejects an invalid phone without sending', async () => {
  const { sent, deps } = makeDeps();
  const result = await sendOtpCore('123', deps);
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
});

test('sendOtpCore sends a 6-digit code and stores it with a 5-minute expiry', async () => {
  const { sent, stored, deps } = makeDeps();
  const result = await sendOtpCore('919876543210', deps);
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '919876543210');
  assert.match(sent[0].message, /\b\d{6}\b/);

  const doc = stored['919876543210'];
  assert.ok(doc);
  assert.match(doc.code, /^\d{6}$/);
  assert.equal(doc.attempts, 0);
  assert.ok(doc.expiresAt - doc.lastSentAt === 5 * 60_000);
});

test('sendOtpCore refuses a resend within the 60s cooldown', async () => {
  const { sent, deps } = makeDeps();
  const now = Date.now();
  deps.getOtpDoc = async () => ({ lastSentAt: now - 1000 } as never);

  const result = await sendOtpCore('919876543210', deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /wait/i);
  assert.equal(sent.length, 0);
});
