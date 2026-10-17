import { getFirestore, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
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
