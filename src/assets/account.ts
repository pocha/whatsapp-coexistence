// What a signed-in user does to their own account, straight from the browser. The
// Firestore rules limit each of these to the user's own records. The browser never handles
// a plaintext Meta token, so rotating the key (which re-encrypts the tokens) goes through
// a Function instead.
import { auth, db, functionsBase } from '/assets/firebase-init.js';
import { hashApiKey, isValidApiKey } from '/assets/api-key.js';
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import type { ApiResponse, GetNumberResponse, ListNumbersResponse, NotificationsResponse, NumberView, RotateKeyRequest, UserDoc } from '../../functions/src/helpers/types';
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
  const numbers = (await numbersOf(uid)).docs;
  // Deleting a number leaves what is under it, so its notifications go first (the rules look the number up).
  for (const snap of numbers) {
    for (;;) {
      const page = await getDocs(query(collection(snap.ref, 'notifications'), limit(450)));
      if (page.empty) break;
      const gone = writeBatch(db);
      page.docs.forEach((n) => gone.delete(n.ref));
      await gone.commit();
    }
  }
  const batch = writeBatch(db);
  for (const snap of numbers) batch.delete(snap.ref);
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

/** Calls a Function with the signed-in user's Firebase ID token (a POST with a body, unless told otherwise). */
export async function callAsUser<T extends ApiResponse = ApiResponse>(url: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const idToken = await auth.currentUser!.getIdToken();
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** The signed-in user's numbers. Read through the Functions, which never send the stored token. */
export async function fetchNumbers(): Promise<NumberView[]> {
  return (await callAsUser<ListNumbersResponse>(`${functionsBase()}/numbers`, undefined, 'GET')).numbers;
}

/** One of the user's numbers, with where its wizard step stands. Throws if it isn't theirs. */
export async function fetchNumber(phoneNumberId: string): Promise<NumberView> {
  return (await callAsUser<GetNumberResponse>(`${functionsBase()}/numbers/${encodeURIComponent(phoneNumberId)}`, undefined, 'GET')).number;
}

/** A page of a number's notifications, newest first; `before` is the `nextBefore` of the page before. */
export async function fetchNotifications(phoneNumberId: string, before?: number): Promise<NotificationsResponse> {
  return callAsUser<NotificationsResponse>(`${functionsBase()}/numbers/${encodeURIComponent(phoneNumberId)}/notifications?limit=20${before ? `&before=${before}` : ''}`, undefined, 'GET');
}
