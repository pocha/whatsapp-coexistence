// The Watobot API key: 32 random bytes as hex, generated here in the browser. The
// server only ever keeps a hash of it, and the browser doesn't keep it at all: the
// user types it whenever it is needed.
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isValidApiKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);

// Must stay identical to hashApiKey in functions/src/helpers/apiKey.ts (a unit test checks it). The
// browser hashes a typed key to compare it with the user's stored apiKeyHash. It never
// encrypts or decrypts Meta tokens: only the server does.
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export async function hashApiKey(apiKey: string): Promise<string> {
  const ikm = await crypto.subtle.importKey('raw', hexToBytes(apiKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('watobot-api-key-auth-v1') },
    ikm,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
