import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, sendOtpCore, verifyOtpCore } from './otp';
import { hashApiKey } from './helpers/apiKey';

test('normalizePhone strips non-digits and rejects out-of-range lengths', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('1'.repeat(16)), null);
  assert.equal(normalizePhone(undefined), null);
});

function makeSendDeps(overrides: Partial<Parameters<typeof sendOtpCore>[1]> = {}) {
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
  const { sent, deps } = makeSendDeps();
  const result = await sendOtpCore('123', deps);
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
});

test('sendOtpCore sends a 6-digit code and stores it with a 5-minute expiry', async () => {
  const { sent, stored, deps } = makeSendDeps();
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
  const { sent, deps } = makeSendDeps();
  const now = Date.now();
  deps.getOtpDoc = async () => ({ lastSentAt: now - 1000 } as never);

  const result = await sendOtpCore('919876543210', deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /wait/i);
  assert.equal(sent.length, 0);
});

interface OtpDoc {
  code: string;
  expiresAt: number;
  attempts: number;
}

const KEY = 'a'.repeat(64);

function makeVerifyDeps(initial: Record<string, OtpDoc> = {}, user: { apiKeyHash?: string } = {}) {
  const store: Record<string, OtpDoc> = { ...initial };
  const calls = { minted: [] as string[], reset: [] as string[] };
  return {
    store,
    calls,
    deps: {
      getOtpDoc: async (phone: string) => store[phone],
      deleteOtpDoc: async (phone: string) => {
        delete store[phone];
      },
      incrementAttempts: async (phone: string) => {
        store[phone].attempts += 1;
      },
      getOrCreateUser: async (phone: string) => ({ userId: 'user-1', phoneNumber: phone, ...user }),
      resetKey: async (userId: string) => {
        calls.reset.push(userId);
      },
      mintToken: async (userId: string) => {
        calls.minted.push(userId);
        return `token-for-${userId}`;
      },
    },
  };
}

const live = () => ({ '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 0 } });

test('rejects a code that was never requested, is wrong, has expired, or has had too many attempts', async () => {
  // No code was ever requested.
  const none = makeVerifyDeps();
  const missing = await verifyOtpCore('919876543210', '123456', {}, none.deps);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /no code requested/i);

  // A wrong code counts an attempt and mints nothing.
  const wrong = makeVerifyDeps(live());
  assert.equal((await verifyOtpCore('919876543210', '000000', {}, wrong.deps)).ok, false);
  assert.equal(wrong.calls.minted.length, 0);
  assert.equal(wrong.store['919876543210'].attempts, 1);

  // An expired code is rejected and removed.
  const expired = makeVerifyDeps({ '919876543210': { code: '654321', expiresAt: Date.now() - 1000, attempts: 0 } });
  const late = await verifyOtpCore('919876543210', '654321', {}, expired.deps);
  assert.match(late.error ?? '', /expired/i);
  assert.equal(expired.store['919876543210'], undefined);

  // Too many attempts locks the code out, even if this one is right.
  const locked = makeVerifyDeps({ '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 5 } });
  const tooMany = await verifyOtpCore('919876543210', '654321', {}, locked.deps);
  assert.match(tooMany.error ?? '', /too many/i);
  assert.equal(locked.store['919876543210'], undefined);
});

test('a correct code for an account with no key signs the user in: a new user, or after a reset', async () => {
  const { store, calls, deps } = makeVerifyDeps(live());
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'token-for-user-1');
  assert.deepEqual(calls.minted, ['user-1']);
  assert.equal(store['919876543210'], undefined);
});

test('an account with a key asks for it after the right code, without using the code up, and never reveals it on a wrong code', async () => {
  const withKey = { apiKeyHash: hashApiKey(KEY) };

  const right = makeVerifyDeps(live(), withKey);
  const result = await verifyOtpCore('919876543210', '654321', {}, right.deps);
  assert.equal(result.ok, false);
  assert.equal(result.needsApiKey, true);
  assert.equal(right.calls.minted.length, 0);
  assert.ok(right.store['919876543210'], 'the code must survive so the key can be sent next');

  const wrong = makeVerifyDeps(live(), withKey);
  assert.equal((await verifyOtpCore('919876543210', '000000', {}, wrong.deps)).needsApiKey, undefined);
});

test('the right key lets the user in; a wrong key counts as an attempt', async () => {
  const good = makeVerifyDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const ok = await verifyOtpCore('919876543210', '654321', { apiKey: KEY }, good.deps);
  assert.equal(ok.ok, true);

  const bad = makeVerifyDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const wrong = await verifyOtpCore('919876543210', '654321', { apiKey: 'b'.repeat(64) }, bad.deps);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needsApiKey, true);
  assert.equal(bad.store['919876543210'].attempts, 1);
});

test('a lost-key reset wipes the stored tokens, then lets the user in', async () => {
  const { calls, deps } = makeVerifyDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const result = await verifyOtpCore('919876543210', '654321', { resetApiKey: true }, deps);
  assert.deepEqual(calls.reset, ['user-1']);
  assert.equal(result.ok, true);
});
