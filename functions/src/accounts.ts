import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './helpers/config';
import { exchangeCodeForToken, getDisplayPhoneNumber } from './helpers/graphApi';
import type { ExchangeCodeRequest, OnboardingResponse, RotateKeyRequest, SignupEvent } from './helpers/types';
import { HttpError, requireAuth } from './helpers/auth';
import { failedRequest, logEvent } from './helpers/log';
import { apiKeyMatchesHash, decryptToken, encryptToken, hashApiKey, isValidApiKey } from './helpers/apiKey';
import { getUser, readNumber, replaceApiKey, saveNumberToken, setDisplayPhoneNumber, setFirstApiKeyHash, type UserRecord } from './helpers/model';

// Keys and tokens: checking an API key, opening the stored Meta token for a request, sealing a
// new one, and the key rotation function. The records themselves are read and written through
// helpers/model.ts, the only file that touches Firestore. The user manages the rest of their
// account from the browser (see src/assets/account.ts and firestore.rules); setFirstApiKey stays
// here for scripts/seed-test-waba.js.

/** Stores the hash of a brand-new API key. Only allowed while the user has none. */
export async function setFirstApiKey(userId: string, apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) throw new HttpError(400, 'That is not a valid API key.');
  const result = await setFirstApiKeyHash(userId, hashApiKey(apiKey));
  if (result === 'no_user') throw new HttpError(404, 'No such user.');
  if (result === 'has_key') throw new HttpError(409, 'This account already has an API key.');
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
  const waba = await readNumber(phoneNumberId);
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

/**
 * Seals a Meta access token under the API key and saves it on the WABA record. The number starts
 * (or restarts) the onboarding wizard (see saveNumberToken).
 */
export async function storeWabaToken(args: {
  userId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  apiKey: string;
  event: SignupEvent;
}): Promise<void> {
  await saveNumberToken({
    userId: args.userId,
    wabaId: args.wabaId,
    phoneNumberId: args.phoneNumberId,
    encAccessToken: encryptToken(args.accessToken, args.apiKey),
    event: args.event,
  });
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

      await replaceApiKey(userId, hashApiKey(newApiKey), (sealed) => {
        let token: string;
        try {
          token = decryptToken(sealed, oldApiKey as string);
        } catch {
          throw new HttpError(500, 'Could not decrypt a stored access token.');
        }
        return encryptToken(token, newApiKey);
      });
      logEvent('key rotated', { userId });
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = failedRequest(req, err);
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
      const { code, wabaId, phoneNumberId, apiKey, event } = (req.body ?? {}) as Partial<ExchangeCodeRequest>;
      if (!code || !ID_RE.test(String(wabaId)) || !ID_RE.test(String(phoneNumberId))) {
        throw new HttpError(400, 'code, wabaId and phoneNumberId are required.');
      }
      if (event !== 'FINISH' && event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        throw new HttpError(400, 'event must be the Embedded Signup event the popup sent.');
      }
      await requireUserKey(userId, apiKey);

      const accessToken = await exchangeCodeForToken(code, config.metaAppId, config.metaAppSecret);
      await storeWabaToken({ userId, wabaId: String(wabaId), phoneNumberId: String(phoneNumberId), accessToken, apiKey: apiKey as string, event });
      // How the number is shown in the dashboard. Best-effort: it falls back to the phone number ID.
      try {
        const displayPhoneNumber = await getDisplayPhoneNumber(String(phoneNumberId), accessToken);
        if (displayPhoneNumber) {
          await setDisplayPhoneNumber(String(phoneNumberId), displayPhoneNumber);
        }
      } catch {
        // Not fatal.
      }
      logEvent('number connected', { phoneNumberId, wabaId, metaEvent: event });
      const body: OnboardingResponse = { ok: true, step: 'override' };
      res.status(200).send({ ...body, wabaId, phoneNumberId });
    } catch (err) {
      const status = failedRequest(req, err);
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
