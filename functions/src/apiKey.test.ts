import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decryptToken, encryptToken, hashApiKey } from './apiKey';

const KEY = '0123456789abcdef'.repeat(4);
const OTHER = 'fedcba9876543210'.repeat(4);

test('a token round-trips under the same key, and cannot be opened with another', () => {
  const enc = encryptToken('EAAB-secret-token', KEY);
  assert.equal(decryptToken(enc, KEY), 'EAAB-secret-token');
  assert.throws(() => decryptToken(enc, OTHER));
});

test('the stored hash is not the encryption key: it cannot open a token', () => {
  const enc = encryptToken('EAAB-secret-token', KEY);
  // Presenting the stored hash as if it were the API key must not decrypt.
  assert.throws(() => decryptToken(enc, hashApiKey(KEY)));
});

async function browserModule() {
  // Load the page's ES module with a native dynamic import (this file compiles to CommonJS).
  const url = pathToFileURL(path.resolve(__dirname, '../../src/assets/api-key.ts')).href;
  const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{
    hashApiKey: (k: string) => Promise<string>;
  }>;
  return nativeImport(url);
}

test('the browser module computes exactly the same hash as the server', async () => {
  const browser = await browserModule();
  assert.equal(await browser.hashApiKey(KEY), hashApiKey(KEY));
  assert.equal(await browser.hashApiKey(OTHER), hashApiKey(OTHER));
});
