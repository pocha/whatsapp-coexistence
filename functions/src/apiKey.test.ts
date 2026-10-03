import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiKeyMatchesHash, decryptToken, encryptToken, hashApiKey, isValidApiKey } from './apiKey';

const KEY = '0123456789abcdef'.repeat(4);
const OTHER = 'fedcba9876543210'.repeat(4);

test('isValidApiKey accepts exactly 64 hex characters', () => {
  assert.equal(isValidApiKey(KEY), true);
  assert.equal(isValidApiKey(KEY.slice(1)), false);
  assert.equal(isValidApiKey(KEY.toUpperCase()), false);
  assert.equal(isValidApiKey(undefined), false);
});

test('a token round-trips under the same key, and cannot be opened with another', () => {
  const enc = encryptToken('EAAB-secret-token', KEY);
  assert.equal(decryptToken(enc, KEY), 'EAAB-secret-token');
  assert.throws(() => decryptToken(enc, OTHER));
});

test('tampering with the ciphertext is detected', () => {
  const enc = encryptToken('EAAB-secret-token', KEY);
  const flipped = Buffer.from(enc.ciphertext, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => decryptToken({ ...enc, ciphertext: flipped.toString('base64') }, KEY));
});

test('each encryption uses a fresh iv', () => {
  assert.notEqual(encryptToken('t', KEY).iv, encryptToken('t', KEY).iv);
});

test('the stored hash checks the right key only', () => {
  const hash = hashApiKey(KEY);
  assert.equal(apiKeyMatchesHash(KEY, hash), true);
  assert.equal(apiKeyMatchesHash(OTHER, hash), false);
});

test('the stored hash is not the encryption key: it cannot open a token', () => {
  const enc = encryptToken('EAAB-secret-token', KEY);
  // Presenting the stored hash as if it were the API key must not decrypt.
  assert.throws(() => decryptToken(enc, hashApiKey(KEY)));
});

test('the browser module computes exactly the same hash as the server', async () => {
  // Load the page's ES module with a native dynamic import (this file compiles to CommonJS).
  const url = pathToFileURL(path.resolve(__dirname, '../../public/assets/api-key.js')).href;
  const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ hashApiKey: (k: string) => Promise<string> }>;
  const browser = await nativeImport(url);
  assert.equal(await browser.hashApiKey(KEY), hashApiKey(KEY));
  assert.equal(await browser.hashApiKey(OTHER), hashApiKey(OTHER));
});
