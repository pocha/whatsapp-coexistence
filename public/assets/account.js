// What a signed-in user does to their own account, straight from the browser. The
// Firestore rules limit each of these to the user's own records. The browser never handles
// a plaintext Meta token, so rotating the key (which re-encrypts the tokens) goes through
// a Function instead.
import { auth, db } from './firebase-init.js';
import { callAsUser, hashApiKey } from './api-key.js';
import { functionsBase } from './firebase-init.js';
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
import { deleteUser } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const userRef = (uid) => doc(db, 'users', uid);
const numbersOf = (uid) => getDocs(query(collection(db, 'wabas'), where('userId', '==', uid)));

/** Saves the hash of a brand-new key (the account has none yet). */
export async function setFirstKey(uid, apiKey) {
  await updateDoc(userRef(uid), { apiKeyHash: await hashApiKey(apiKey), rotatedAt: Date.now() });
}

/** Replaces the key. The server re-encrypts every stored token, so the old key is needed. */
export const rotateKey = (oldKey, newKey) =>
  callAsUser(auth, `${functionsBase()}/rotateKey`, { oldApiKey: oldKey, newApiKey: newKey });

/**
 * For a lost key: the stored tokens can't be opened without it, so they are deleted
 * along with the key hash. The number records stay, but each must be onboarded again.
 */
export async function resetKey(uid) {
  const batch = writeBatch(db);
  for (const snap of (await numbersOf(uid)).docs) batch.update(snap.ref, { encAccessToken: deleteField() });
  batch.update(userRef(uid), { apiKeyHash: deleteField(), rotatedAt: Date.now() });
  await batch.commit();
}

/** Deletes everything we hold for the user, then their sign-in. */
export async function deleteAccount(uid) {
  const phoneNumber = (await getDoc(userRef(uid))).data()?.phoneNumber;
  const batch = writeBatch(db);
  for (const snap of (await numbersOf(uid)).docs) batch.delete(snap.ref);
  if (phoneNumber) batch.delete(doc(db, 'phoneIndex', phoneNumber));
  batch.delete(userRef(uid));
  await batch.commit();
  await deleteUser(auth.currentUser).catch(() => undefined);
}
