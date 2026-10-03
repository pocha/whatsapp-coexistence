// What a signed-in user does to their own account, straight from the browser. The
// Firestore rules limit each of these to the user's own records. The browser never handles
// a plaintext Meta token, so rotating the key (which re-encrypts the tokens) goes through
// a Function instead.
import { auth, db, functionsBase } from './firebase-init.js';
import { hashApiKey, isValidApiKey } from './api-key.js';
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import type { ApiResponse, RotateKeyRequest, UserDoc } from '../../functions/src/helpers/types';
import { deleteUser } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const userRef = (uid: string) => doc(db, 'users', uid);
const numbersOf = (uid: string) => getDocs(query(collection(db, 'phoneNumbers'), where('userId', '==', uid)));

/** Saves the hash of a brand-new key (the account has none yet). */
export async function setFirstKey(uid: string, apiKey: string) {
  await updateDoc(userRef(uid), { apiKeyHash: await hashApiKey(apiKey), rotatedAt: Date.now() });
}

/** Replaces the key. The server re-encrypts every stored token, so the old key is needed. */
export const rotateKey = (oldKey: string, newKey: string) =>
  callAsUser(`${functionsBase()}/rotateKey`, { oldApiKey: oldKey, newApiKey: newKey } satisfies RotateKeyRequest);

/**
 * For a lost key: the stored tokens can't be opened without it, so they are deleted
 * along with the key hash. The number records stay, but each must be onboarded again.
 */
export async function resetKey(uid: string) {
  const batch = writeBatch(db);
  for (const snap of (await numbersOf(uid)).docs) batch.update(snap.ref, { encAccessToken: deleteField() });
  batch.update(userRef(uid), { apiKeyHash: deleteField(), rotatedAt: Date.now() });
  await batch.commit();
}

/** Deletes everything we hold for the user, then their sign-in. */
export async function deleteAccount(uid: string) {
  const phoneNumber = (await getDoc(userRef(uid))).data()?.phoneNumber as string | undefined;
  const batch = writeBatch(db);
  for (const snap of (await numbersOf(uid)).docs) batch.delete(snap.ref);
  if (phoneNumber) batch.delete(doc(db, 'phoneIndex', phoneNumber));
  batch.delete(userRef(uid));
  await batch.commit();
  if (auth.currentUser) await deleteUser(auth.currentUser).catch(() => undefined);
}

/** True if `apiKey` matches the hash on the signed-in user's own record. */
export async function keyMatchesAccount(uid: string, apiKey: string): Promise<boolean> {
  if (!isValidApiKey(apiKey)) return false;
  const stored = ((await getDoc(userRef(uid))).data() as UserDoc | undefined)?.apiKeyHash;
  return Boolean(stored) && stored === (await hashApiKey(apiKey));
}

/** POSTs to a Function with the signed-in user's Firebase ID token. */
export async function callAsUser<T extends ApiResponse = ApiResponse>(url: string, body: unknown): Promise<T> {
  const idToken = await auth.currentUser!.getIdToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
