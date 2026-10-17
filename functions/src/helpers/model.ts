import { FieldValue, getFirestore, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import type { PhoneNumberDoc, UserDoc } from './types';

// The Firestore collections, in one place: their names, and the types of what they hold. Server
// only (the browser reads Firestore through its own SDK and shares just the types).
//
//   users/{userId}                phoneNumber, apiKeyHash, createdAt, rotatedAt
//   phoneIndex/{phone}            userId (makes phone -> user creation race-free)
//   phoneNumbers/{phoneNumberId}  one per onboarded number: see PhoneNumberDoc in types.ts
//   otps/{phone}                  sign-in codes (no browser can read them)
//   testRuns/{userId}             the codes of the last "send test data" (no browser can read them)
//   meta/waitlist                 the waitlist click counter
//
// References come from functions rather than constants because getFirestore() can only be called
// once the app is initialised (index.ts does that first).

/** The Firestore handle, for transactions and batches. */
export const firestore = (): Firestore => getFirestore();

export const phoneNumbers = () => getFirestore().collection('phoneNumbers');
export const phoneNumberRef = (phoneNumberId: string) => phoneNumbers().doc(phoneNumberId);

export const users = () => getFirestore().collection('users');
export const userRef = (userId: string) => users().doc(userId);

export const phoneIndexRef = (phone: string) => getFirestore().collection('phoneIndex').doc(phone);
export const otpRef = (phone: string) => getFirestore().collection('otps').doc(phone);
export const testRunRef = (userId: string) => getFirestore().collection('testRuns').doc(userId);
export const waitlistRef = () => getFirestore().collection('meta').doc('waitlist');

/** What a snapshot of each collection holds, typed once here instead of at every read. */
export const numberOf = (snap: DocumentSnapshot) => snap.data() as PhoneNumberDoc | undefined;
export const userOf = (snap: DocumentSnapshot) => snap.data() as UserDoc | undefined;

export async function readNumber(phoneNumberId: string): Promise<PhoneNumberDoc | undefined> {
  return numberOf(await phoneNumberRef(phoneNumberId).get());
}

/** Every number a user has onboarded. */
export const numbersOf = (userId: string) => phoneNumbers().where('userId', '==', userId).get();

export interface UserRecord {
  userId: string;
  phoneNumber: string;
  apiKeyHash?: string;
}

/** Finds the user for a phone number, creating one (with a random id) if none exists. */
export async function getOrCreateUserByPhone(phone: string): Promise<UserRecord> {
  return firestore().runTransaction(async (tx) => {
    const indexRef = phoneIndexRef(phone);
    const indexSnap = await tx.get(indexRef);

    if (indexSnap.exists) {
      const userId = indexSnap.data()!.userId as string;
      const userSnap = await tx.get(userRef(userId));
      return { userId, phoneNumber: phone, apiKeyHash: userOf(userSnap)?.apiKeyHash };
    }

    const newUser = users().doc();
    tx.set(newUser, { phoneNumber: phone, createdAt: Date.now() });
    tx.set(indexRef, { userId: newUser.id });
    return { userId: newUser.id, phoneNumber: phone };
  });
}

export async function getUser(userId: string): Promise<UserRecord | undefined> {
  const data = userOf(await userRef(userId).get());
  if (!data) return undefined;
  return { userId, phoneNumber: data.phoneNumber, apiKeyHash: data.apiKeyHash };
}

/**
 * For a lost key: the stored tokens can't be opened without it, so they are
 * deleted along with the key hash. The WABA records stay, but each number has to
 * be onboarded again before it can send.
 */
export async function resetApiKey(userId: string): Promise<number> {
  const numbers = await numbersOf(userId);
  const batch = firestore().batch();
  let wiped = 0;
  numbers.forEach((snap) => {
    if (numberOf(snap)!.encAccessToken) wiped += 1;
    batch.update(snap.ref, { encAccessToken: FieldValue.delete() });
  });
  batch.update(userRef(userId), { apiKeyHash: FieldValue.delete(), rotatedAt: Date.now() });
  await batch.commit();
  return wiped;
}
