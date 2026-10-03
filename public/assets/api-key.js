// The Watobot API key: 32 random bytes as hex, generated here in the browser. The
// server only ever keeps a hash of it, and the browser doesn't keep it at all: the
// user types it whenever it is needed.
export function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isValidApiKey = (key) => /^[0-9a-f]{64}$/.test(key ?? '');

// Must stay identical to hashApiKey in functions/src/apiKey.ts (a unit test checks it). The
// browser hashes a typed key to compare it with the user's stored apiKeyHash. It never
// encrypts or decrypts Meta tokens: only the server does.
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

export async function hashApiKey(apiKey) {
  const ikm = await crypto.subtle.importKey('raw', hexToBytes(apiKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('watobot-api-key-auth-v1') },
    ikm,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
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
