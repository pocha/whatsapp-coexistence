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

test('rejects when no code was ever requested', async () => {
  const { deps } = makeDeps();
  const result = await verifyOtpCore('919876543210', '123456', {}, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no code requested/i);
});

test('a correct code for an account with no key mints a token for the user id and asks for key setup', async () => {
  const { store, calls, deps } = makeDeps(live());
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'token-for-user-1');
  assert.equal(result.needsKeySetup, true);
  assert.deepEqual(calls.minted, ['user-1']);
  assert.equal(store['919876543210'], undefined);
});

test('a wrong code increments attempts and mints nothing', async () => {
  const { store, calls, deps } = makeDeps(live());
  const result = await verifyOtpCore('919876543210', '000000', {}, deps);
  assert.equal(result.ok, false);
  assert.equal(calls.minted.length, 0);
  assert.equal(store['919876543210'].attempts, 1);
});

test('an expired code is rejected and removed', async () => {
  const { store, deps } = makeDeps({ '919876543210': { code: '654321', expiresAt: Date.now() - 1000, attempts: 0 } });
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /expired/i);
  assert.equal(store['919876543210'], undefined);
});

test('locks out after too many attempts', async () => {
  const { store, deps } = makeDeps({ '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 5 } });
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /too many/i);
  assert.equal(store['919876543210'], undefined);
});

test('an account with a key asks for it after the code, without consuming the code', async () => {
  const { store, calls, deps } = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const result = await verifyOtpCore('919876543210', '654321', {}, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needsApiKey, true);
  assert.equal(calls.minted.length, 0);
  assert.ok(store['919876543210'], 'the code must survive so the key can be sent next');
});

test('never reveals whether an account has a key when the code is wrong', async () => {
  const { deps } = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const result = await verifyOtpCore('919876543210', '000000', {}, deps);
  assert.equal(result.needsApiKey, undefined);
});

test('the right key lets the user in; a wrong key counts as an attempt', async () => {
  const good = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const ok = await verifyOtpCore('919876543210', '654321', { apiKey: KEY }, good.deps);
  assert.equal(ok.ok, true);
  assert.equal(ok.needsKeySetup, false);

  const bad = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const wrong = await verifyOtpCore('919876543210', '654321', { apiKey: 'b'.repeat(64) }, bad.deps);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needsApiKey, true);
  assert.equal(bad.store['919876543210'].attempts, 1);
});

test('a lost-key reset wipes the stored tokens, then lets the user in to set a new key', async () => {
  const { calls, deps } = makeDeps(live(), { apiKeyHash: hashApiKey(KEY) });
  const result = await verifyOtpCore('919876543210', '654321', { resetApiKey: true }, deps);
  assert.deepEqual(calls.reset, ['user-1']);
  assert.equal(result.ok, true);
  assert.equal(result.needsKeySetup, true);
});
