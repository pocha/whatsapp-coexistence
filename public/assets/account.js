// What a signed-in user does to their own account, straight from the browser. The
// Firestore rules limit each of these to the user's own records. Nothing here uses a
// Function: the user holds the key, so the user does it.
import { auth, db } from './firebase-init.js';
import { decryptToken, encryptToken, hashApiKey } from './api-key.js';
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

/**
 * Replaces the key: re-encrypts every stored Meta token under the new key and stores
 * the new hash, in one atomic batch. Needs the current key, so nothing is lost.
 */
export async function rotateKey(uid, oldKey, newKey) {
  const stored = (await getDoc(userRef(uid))).data()?.apiKeyHash;
  if (!stored || stored !== (await hashApiKey(oldKey))) throw new Error('That is not the current key for this account.');

  const batch = writeBatch(db);
  for (const snap of (await numbersOf(uid)).docs) {
    const enc = snap.data().encAccessToken;
    if (enc) batch.update(snap.ref, { encAccessToken: await encryptToken(await decryptToken(enc, oldKey), newKey) });
  }
  batch.update(userRef(uid), { apiKeyHash: await hashApiKey(newKey), rotatedAt: Date.now() });
  await batch.commit();
}

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
