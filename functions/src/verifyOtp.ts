import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { normalizePhone } from './sendOtp';

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
  error?: string;
}

/** Pulled out of the onRequest handler for unit testability, same pattern as sendOtpCore. */
export async function verifyOtpCore(
  phone: string | undefined,
  code: string | undefined,
  deps: {
    getOtpDoc: (phone: string) => Promise<OtpDoc | undefined>;
    deleteOtpDoc: (phone: string) => Promise<void>;
    incrementAttempts: (phone: string) => Promise<void>;
    mintToken: (phone: string) => Promise<string>;
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

  await deps.deleteOtpDoc(normalized);
  const token = await deps.mintToken(normalized);
  return { ok: true, token };
}

export const verifyOtp = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const db = getFirestore();
    try {
      const result = await verifyOtpCore(req.body?.phone, req.body?.code, {
        getOtpDoc: async (phone) => (await db.collection('otps').doc(phone).get()).data() as OtpDoc | undefined,
        deleteOtpDoc: async (phone) => {
          await db.collection('otps').doc(phone).delete();
        },
        incrementAttempts: async (phone) => {
          await db.collection('otps').doc(phone).update({ attempts: FieldValue.increment(1) });
        },
        mintToken: (phone) => getAuth().createCustomToken(phone),
      });
      res.status(result.ok ? 200 : 400).send(result);
    } catch (err) {
      // Same reasoning as sendOtp's catch — an uncaught exception here would
      // produce a response with no CORS headers, which browsers misreport as
      // a CORS policy error instead of the real failure.
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
