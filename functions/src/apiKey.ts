import { hkdfSync, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EncryptedToken } from './types';

// The customer's Watobot API key is 32 random bytes as hex, generated in their
// browser. We never store it. From it we derive two independent values with
// HKDF, each under its own label:
//   - an authentication hash, stored on the user, to check a presented key;
//   - an encryption key, never stored, that seals each WABA's Meta access token.
// Because the labels differ, the stored hash can't be used to decrypt anything.
const AUTH_INFO = 'watobot-api-key-auth-v1';
const ENC_INFO = 'watobot-api-key-enc-v1';

export type { EncryptedToken };

export function isValidApiKey(key: unknown): key is string {
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);
}

function derive(apiKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(apiKey, 'hex'), Buffer.alloc(0), info, 32));
}

export function hashApiKey(apiKey: string): string {
  return derive(apiKey, AUTH_INFO).toString('hex');
}

export function apiKeyMatchesHash(apiKey: string, storedHash: string): boolean {
  if (!isValidApiKey(apiKey)) return false;
  const a = Buffer.from(hashApiKey(apiKey), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encryptToken(accessToken: string, apiKey: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(apiKey, ENC_INFO), iv);
  const ciphertext = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptToken(enc: EncryptedToken, apiKey: string): string {
  const decipher = createDecipheriv('aes-256-gcm', derive(apiKey, ENC_INFO), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
