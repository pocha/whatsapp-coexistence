import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOtpCore } from './verifyOtp';

interface OtpDoc {
  code: string;
  expiresAt: number;
  attempts: number;
}

function makeDeps(initial: Record<string, OtpDoc> = {}) {
  const store: Record<string, OtpDoc> = { ...initial };
  const mintedFor: string[] = [];
  return {
    store,
    mintedFor,
    deps: {
      getOtpDoc: async (phone: string) => store[phone],
      deleteOtpDoc: async (phone: string) => {
        delete store[phone];
      },
      incrementAttempts: async (phone: string) => {
        store[phone].attempts += 1;
      },
      mintToken: async (phone: string) => {
        mintedFor.push(phone);
        return `token-for-${phone}`;
      },
    },
  };
}

test('verifyOtpCore rejects when no code was ever requested', async () => {
  const { deps } = makeDeps();
  const result = await verifyOtpCore('919876543210', '123456', deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no code requested/i);
});

test('verifyOtpCore mints a token and deletes the doc on a correct code', async () => {
  const { store, mintedFor, deps } = makeDeps({
    '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 0 },
  });
  const result = await verifyOtpCore('919876543210', '654321', deps);
  assert.equal(result.ok, true);
  assert.equal(result.token, 'token-for-919876543210');
  assert.deepEqual(mintedFor, ['919876543210']);
  assert.equal(store['919876543210'], undefined);
});

test('verifyOtpCore increments attempts on a wrong code without minting a token', async () => {
  const { store, mintedFor, deps } = makeDeps({
    '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 0 },
  });
  const result = await verifyOtpCore('919876543210', '000000', deps);
  assert.equal(result.ok, false);
  assert.equal(mintedFor.length, 0);
  assert.equal(store['919876543210'].attempts, 1);
});

test('verifyOtpCore rejects an expired code and deletes the doc', async () => {
  const { store, deps } = makeDeps({
    '919876543210': { code: '654321', expiresAt: Date.now() - 1000, attempts: 0 },
  });
  const result = await verifyOtpCore('919876543210', '654321', deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /expired/i);
  assert.equal(store['919876543210'], undefined);
});

test('verifyOtpCore locks out after too many attempts', async () => {
  const { store, deps } = makeDeps({
    '919876543210': { code: '654321', expiresAt: Date.now() + 60_000, attempts: 5 },
  });
  const result = await verifyOtpCore('919876543210', '654321', deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /too many/i);
  assert.equal(store['919876543210'], undefined);
});
