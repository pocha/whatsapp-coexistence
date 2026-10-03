import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOtpCore } from './verifyOtp';
import { hashApiKey } from './apiKey';

interface OtpDoc {
  code: string;
  expiresAt: number;
  attempts: number;
}

const KEY = 'a'.repeat(64);

function makeDeps(initial: Record<string, OtpDoc> = {}, user: { apiKeyHash?: string } = {}) {
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
  const none = makeDeps();
  const missing = await verifyOtpCore('919876543210', '123456', {}, none.deps);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /no code requested/i);

  // A wrong code counts an attempt and mints nothing.
  const wrong = makeDeps(live());
  assert.equal((await verifyOtpCore('919876543210', '000000', {}, wrong.deps)).ok, false);
  assert.equal(wrong.calls.minted.length, 0);
  assert.equal(wrong.store['919876543210'].attempts, 1);

  // An expired code is rejected and removed.
  const expired = makeDeps({ '919876543210': { code: '654321', expiresAt: Date.now() - 1000, attempts: 0 } });
  const late = await verifyOtpCore('919876543210', '654321', {}, expired.deps);
  assert.match(late.error ?? '', /expired/i);
  assert.equal(expired.store['919876543210'], undefined);

  // Too many attempts locks the code out, even if this one is right.
  const locked = makeDeps({ '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 5 } });
  const tooMany = await verifyOtpCore('919876543210', '654321', {}, locked.deps);
  assert.match(tooMany.error ?? '', /too many/i);
  assert.equal(locked.store['919876543210'], undefined);
});

test('a correct code for an account with no key signs the user in: a new user, or after a reset', async () => {
  const { store, calls, deps } = makeDeps(live());
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'token-for-user-1');
  assert.deepEqual(calls.minted, ['user-1']);
  assert.equal(store['919876543210'], undefined);
});

test('an account with a key asks for it after the right code, without using the code up, and never reveals it on a wrong code', async () => {
  const withKey = { apiKeyHash: hashApiKey(KEY) };

  const right = makeDeps(live(), withKey);
  const result = await verifyOtpCore('919876543210', '654321', {}, right.deps);
  assert.equal(result.ok, false);
  assert.equal(result.needsApiKey, true);
  assert.equal(right.calls.minted.length, 0);
  assert.ok(right.store['919876543210'], 'the code must survive so the key can be sent next');

  const wrong = makeDeps(live(), withKey);
  assert.equal((await verifyOtpCore('919876543210', '000000', {}, wrong.deps)).needsApiKey, undefined);
});

test('the right key lets the user in; a wrong key counts as an attempt', async () => {
  const good = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const ok = await verifyOtpCore('919876543210', '654321', { apiKey: KEY }, good.deps);
  assert.equal(ok.ok, true);

  const bad = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const wrong = await verifyOtpCore('919876543210', '654321', { apiKey: 'b'.repeat(64) }, bad.deps);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needsApiKey, true);
  assert.equal(bad.store['919876543210'].attempts, 1);
});

test('a lost-key reset wipes the stored tokens, then lets the user in', async () => {
  const { calls, deps } = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const result = await verifyOtpCore('919876543210', '654321', { resetApiKey: true }, deps);
  assert.deepEqual(calls.reset, ['user-1']);
  assert.equal(result.ok, true);
});
