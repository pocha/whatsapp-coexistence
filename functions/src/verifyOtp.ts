import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { normalizePhone } from './sendOtp';
import { apiKeyMatchesHash, isValidApiKey } from './apiKey';
import { getOrCreateUserByPhone, resetApiKey, type UserRecord } from './accounts';

const corsHandler = cors({ origin: true });
const MAX_ATTEMPTS = 5;

interface OtpDoc {
  code: string;
  expiresAt: number;
  attempts: number;
}

export interface VerifyOtpResult {
  ok: boolean;
  token?: string;
  /** The code was right, but this account has an API key and none (or a wrong one) was sent. */
  needsApiKey?: boolean;
  /** The account has no API key yet, so the dashboard should set one up. */
  needsKeySetup?: boolean;
  error?: string;
}

/** Pulled out of the onRequest handler for unit testability, same pattern as sendOtpCore. */
export async function verifyOtpCore(
  phone: string | undefined,
  code: string | undefined,
  options: { apiKey?: string; resetApiKey?: boolean },
  deps: {
    getOtpDoc: (phone: string) => Promise<OtpDoc | undefined>;
    deleteOtpDoc: (phone: string) => Promise<void>;
    incrementAttempts: (phone: string) => Promise<void>;
    getOrCreateUser: (phone: string) => Promise<UserRecord>;
    resetKey: (userId: string) => Promise<unknown>;
    mintToken: (userId: string) => Promise<string>;
  },
): Promise<VerifyOtpResult> {
  const normalized = normalizePhone(phone);
  if (!normalized || !code) return { ok: false, error: 'Phone and code are required.' };

  const otp = await deps.getOtpDoc(normalized);
  if (!otp) return { ok: false, error: 'No code requested for this number — request a new one.' };

  if (Date.now() > otp.expiresAt) {
    await deps.deleteOtpDoc(normalized);
    return { ok: false, error: 'Code expired — request a new one.' };
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    await deps.deleteOtpDoc(normalized);
    return { ok: false, error: 'Too many incorrect attempts — request a new code.' };
  }

  if (otp.code !== code) {
    await deps.incrementAttempts(normalized);
    return { ok: false, error: 'Incorrect code.' };
  }

  // The code is right. Only now do we look at the account, so nobody can learn
  // whether a number is a customer (or has an API key) without receiving its OTP.
  let user = await deps.getOrCreateUser(normalized);

  if (user.apiKeyHash && options.resetApiKey) {
    await deps.resetKey(user.userId);
    user = { ...user, apiKeyHash: undefined };
  }

  if (user.apiKeyHash) {
    if (!options.apiKey) return { ok: false, needsApiKey: true };
    if (!isValidApiKey(options.apiKey) || !apiKeyMatchesHash(options.apiKey, user.apiKeyHash)) {
      await deps.incrementAttempts(normalized);
      return { ok: false, needsApiKey: true, error: 'Incorrect API key.' };
    }
  }

  await deps.deleteOtpDoc(normalized);
  const token = await deps.mintToken(user.userId);
  return { ok: true, token, needsKeySetup: !user.apiKeyHash };
}

export const verifyOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const db = getFirestore();
    try {
      const result = await verifyOtpCore(
        req.body?.phone,
        req.body?.code,
        { apiKey: req.body?.apiKey, resetApiKey: req.body?.resetApiKey === true },
        {
          getOtpDoc: async (phone) => (await db.collection('otps').doc(phone).get()).data() as OtpDoc | undefined,
          deleteOtpDoc: async (phone) => {
            await db.collection('otps').doc(phone).delete();
          },
          incrementAttempts: async (phone) => {
            await db.collection('otps').doc(phone).update({ attempts: FieldValue.increment(1) });
          },
          getOrCreateUser: getOrCreateUserByPhone,
          resetKey: resetApiKey,
          mintToken: (userId) => getAuth().createCustomToken(userId),
        },
      );
      res.status(result.ok || result.needsApiKey ? 200 : 400).send(result);
    } catch (err) {
      // Without this, an exception propagates out of this callback uncaught — the
      // response then has no CORS headers, which browsers misreport as a CORS error.
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
