// The Watobot API key: 32 random bytes as hex, generated here in the browser. The
// server only ever keeps a hash of it, and the browser doesn't keep it at all: the
// user types it whenever it is needed.
export function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isValidApiKey = (key) => /^[0-9a-f]{64}$/.test(key ?? '');

// These must stay identical to hashApiKey / encryptToken / decryptToken in
// functions/src/apiKey.ts (unit tests check both directions). The browser hashes a typed
// key to compare it with the user's stored apiKeyHash, and re-encrypts the stored Meta
// tokens when the key is rotated.
const AUTH_INFO = 'watobot-api-key-auth-v1';
const ENC_INFO = 'watobot-api-key-enc-v1';

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derive(apiKey, info, algorithm, usages) {
  const ikm = await crypto.subtle.importKey('raw', hexToBytes(apiKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    ikm,
    256,
  );
  return algorithm ? crypto.subtle.importKey('raw', bits, algorithm, false, usages) : bits;
}

export async function hashApiKey(apiKey) {
  return Array.from(new Uint8Array(await derive(apiKey, AUTH_INFO)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The stored form splits AES-GCM's output into ciphertext and authTag (WebCrypto joins them).
export async function encryptToken(accessToken, apiKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(apiKey, ENC_INFO, 'AES-GCM', ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(accessToken)));
  return {
    ciphertext: toBase64(sealed.slice(0, -16)),
    iv: toBase64(iv),
    authTag: toBase64(sealed.slice(-16)),
  };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function decryptToken(enc, apiKey) {
  const key = await derive(apiKey, ENC_INFO, 'AES-GCM', ['decrypt']);
  const sealed = new Uint8Array([...fromBase64(enc.ciphertext), ...fromBase64(enc.authTag)]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(enc.iv) }, key, sealed));
}

/** True if `apiKey` matches the signed-in user's stored hash (read from their own user doc). */
export async function keyMatchesAccount(db, getDoc, doc, uid, apiKey) {
  if (!isValidApiKey(apiKey)) return false;
  const stored = (await getDoc(doc(db, 'users', uid))).data()?.apiKeyHash;
  return Boolean(stored) && stored === (await hashApiKey(apiKey));
}

/** POSTs to a Function with the signed-in user's Firebase ID token. */
export async function callAsUser(auth, url, body) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
