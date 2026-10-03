import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import cors from 'cors';
import { config } from './helpers/config';
import { exchangeCodeForToken } from './helpers/graphApi';
import type { ExchangeCodeRequest, PhoneNumberDoc, RotateKeyRequest } from './helpers/types';
import { HttpError, requireAuth } from './helpers/auth';
import { apiKeyMatchesHash, decryptToken, encryptToken, hashApiKey, isValidApiKey } from './helpers/apiKey';

// Data model:
//   users/{userId}           phoneNumber, apiKeyHash, createdAt, rotatedAt
//   phoneIndex/{phone}       userId (makes phone -> user creation race-free)
//   phoneNumbers/{phoneNumberId}  userId, wabaId, phoneNumberId, encAccessToken, ...
// Functions create these and run the relay, webhook, onboarding and key rotation (rotateKey,
// below). The user manages the rest of their account from the browser (see
// src/assets/account.ts and firestore.rules); resetApiKey and setFirstApiKey stay here for
// the sign-in reset and for scripts/seed-test-waba.js.

export interface UserRecord {
  userId: string;
  phoneNumber: string;
  apiKeyHash?: string;
}

/** Finds the user for a phone number, creating one (with a random id) if none exists. */
export async function getOrCreateUserByPhone(phone: string): Promise<UserRecord> {
  const db = getFirestore();
  return db.runTransaction(async (tx) => {
    const indexRef = db.collection('phoneIndex').doc(phone);
    const indexSnap = await tx.get(indexRef);

    if (indexSnap.exists) {
      const userId = indexSnap.data()!.userId as string;
      const userSnap = await tx.get(db.collection('users').doc(userId));
      return { userId, phoneNumber: phone, apiKeyHash: userSnap.data()?.apiKeyHash as string | undefined };
    }

    const userRef = db.collection('users').doc();
    tx.set(userRef, { phoneNumber: phone, createdAt: Date.now() });
    tx.set(indexRef, { userId: userRef.id });
    return { userId: userRef.id, phoneNumber: phone };
  });
}

export async function getUser(userId: string): Promise<UserRecord | undefined> {
  const snap = await getFirestore().collection('users').doc(userId).get();
  if (!snap.exists) return undefined;
  const data = snap.data()!;
  return { userId, phoneNumber: data.phoneNumber as string, apiKeyHash: data.apiKeyHash as string | undefined };
}

/** Stores the hash of a brand-new API key. Only allowed while the user has none. */
export async function setFirstApiKey(userId: string, apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) throw new HttpError(400, 'That is not a valid API key.');
  const ref = getFirestore().collection('users').doc(userId);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'No such user.');
    if (snap.data()!.apiKeyHash) throw new HttpError(409, 'This account already has an API key.');
    tx.update(ref, { apiKeyHash: hashApiKey(apiKey), rotatedAt: Date.now() });
  });
}

/** Throws unless `apiKey` is the key for this user. Returns the user. */
export async function requireUserKey(userId: string, apiKey: unknown): Promise<UserRecord> {
  const user = await getUser(userId);
  if (!user?.apiKeyHash) throw new HttpError(403, 'Set up your API key first.');
  if (!isValidApiKey(apiKey) || !apiKeyMatchesHash(apiKey, user.apiKeyHash)) {
    throw new HttpError(401, 'Incorrect API key.');
  }
  return user;
}

/**
 * Authenticates a caller by phoneNumberId + Watobot API key, and returns the
 * decrypted Meta access token for that number. The token only exists in memory
 * for the length of the request.
 */
export async function authenticateKey(
  phoneNumberId: string,
  apiKey: unknown,
): Promise<{ userId: string; wabaId: string; accessToken: string }> {
  const db = getFirestore();
  const wabaSnap = await db.collection('phoneNumbers').doc(phoneNumberId).get();
  const waba = wabaSnap.data() as PhoneNumberDoc | undefined;
  if (!waba) throw new HttpError(404, 'Unknown phone number ID.');

  const user = await requireUserKey(waba.userId, apiKey);
  const enc = waba.encAccessToken;
  if (!enc) throw new HttpError(409, 'This number has no stored access token. Onboard it again.');

  try {
    return { userId: user.userId, wabaId: waba.wabaId, accessToken: decryptToken(enc, apiKey as string) };
  } catch {
    throw new HttpError(500, 'Could not decrypt the stored access token.');
  }
}

/** Seals a Meta access token under the API key and saves it on the WABA record. */
export async function storeWabaToken(args: {
  userId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  apiKey: string;
}): Promise<void> {
  await getFirestore()
    .collection('phoneNumbers')
    .doc(args.phoneNumberId)
    .set(
      {
        userId: args.userId,
        wabaId: args.wabaId,
        phoneNumberId: args.phoneNumberId,
        encAccessToken: encryptToken(args.accessToken, args.apiKey),
      },
      { merge: true },
    );
}

async function numbersOf(userId: string) {
  return getFirestore().collection('phoneNumbers').where('userId', '==', userId).get();
}

/**
 * For a lost key: the stored tokens can't be opened without it, so they are
 * deleted along with the key hash. The WABA records stay, but each number has to
 * be onboarded again before it can send.
 */
export async function resetApiKey(userId: string): Promise<number> {
  const db = getFirestore();
  const numbers = await numbersOf(userId);
  const batch = db.batch();
  let wiped = 0;
  numbers.forEach((snap) => {
    if (snap.data().encAccessToken) wiped += 1;
    batch.update(snap.ref, { encAccessToken: FieldValue.delete() });
  });
  batch.update(db.collection('users').doc(userId), { apiKeyHash: FieldValue.delete(), rotatedAt: Date.now() });
  await batch.commit();
  return wiped;
}

const corsHandler = cors({ origin: true });

// Replaces the signed-in user's API key. Needs the current key; every stored Meta token is
// re-encrypted under the new one, and the new hash is saved, in one atomic batch. This runs
// server-side so the plaintext token is only ever in this function's memory, never in the browser.
export const rotateKey = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      const userId = await requireAuth(req);
      const { oldApiKey, newApiKey } = (req.body ?? {}) as Partial<RotateKeyRequest>;
      await requireUserKey(userId, oldApiKey);
      if (!isValidApiKey(newApiKey)) throw new HttpError(400, 'That is not a valid new API key.');

      const db = getFirestore();
      const batch = db.batch();
      (await numbersOf(userId)).forEach((snap) => {
        const enc = (snap.data() as PhoneNumberDoc).encAccessToken;
        if (!enc) return;
        let token: string;
        try {
          token = decryptToken(enc, oldApiKey as string);
        } catch {
          throw new HttpError(500, 'Could not decrypt a stored access token.');
        }
        batch.update(snap.ref, { encAccessToken: encryptToken(token, newApiKey) });
      });
      batch.update(db.collection('users').doc(userId), { apiKeyHash: hashApiKey(newApiKey), rotatedAt: Date.now() });
      await batch.commit();
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});

const ID_RE = /^\d{1,32}$/;

// Exchanges the Embedded Signup `code` for the customer's Meta access token and
// stores it encrypted under the signed-in user's Watobot API key. The App Secret
// is needed for the exchange, which is why this runs server-side. The plaintext
// token only lives in memory for this request: it is never returned, stored or
// logged in the clear.
export const exchangeCode = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      const userId = await requireAuth(req);
      const { code, wabaId, phoneNumberId, apiKey } = (req.body ?? {}) as Partial<ExchangeCodeRequest>;
      if (!code || !ID_RE.test(String(wabaId)) || !ID_RE.test(String(phoneNumberId))) {
        throw new HttpError(400, 'code, wabaId and phoneNumberId are required.');
      }
      await requireUserKey(userId, apiKey);

      const accessToken = await exchangeCodeForToken(code, config.metaAppId, config.metaAppSecret);
      await storeWabaToken({ userId, wabaId: String(wabaId), phoneNumberId: String(phoneNumberId), accessToken, apiKey: apiKey as string });
      res.status(200).send({ ok: true, wabaId, phoneNumberId });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
