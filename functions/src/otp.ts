import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { config } from './helpers/config';
import { sendWhatsappMessage } from './helpers/watobotApi';
import { apiKeyMatchesHash, isValidApiKey } from './helpers/apiKey';
import { getOrCreateUserByPhone, resetApiKey, type UserRecord } from './accounts';

// Login by phone number and a WhatsApp one-time code: sendOtp sends it, verifyOtp checks it
// (and the account's API key, once it has one) and mints the Firebase sign-in token.

const corsHandler = cors({ origin: true });
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;
const OTP_TTL_MS = 5 * 60_000;

export function normalizePhone(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export interface SendOtpResult {
  ok: boolean;
  error?: string;
}

/**
 * Pulled out of the onRequest handler for unit testability — takes the
 * Firestore/send dependencies as params rather than reading them from module
 * scope, so tests can stub both without touching real Firestore or watobot.
 */
export async function sendOtpCore(
  phone: string | undefined,
  deps: {
    getOtpDoc: (phone: string) => Promise<{ lastSentAt?: number } | undefined>;
    setOtpDoc: (phone: string, data: { code: string; expiresAt: number; attempts: number; lastSentAt: number }) => Promise<void>;
    sendMessage: (phone: string, message: string) => Promise<void>;
  },
): Promise<SendOtpResult> {
  const normalized = normalizePhone(phone);
  if (!normalized) return { ok: false, error: 'Enter a valid WhatsApp number, including country code.' };

  const existing = await deps.getOtpDoc(normalized);
  const now = Date.now();
  if (existing?.lastSentAt && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
    return { ok: false, error: `Wait ${waitSec}s before requesting another code.` };
  }

  const code = generateCode();
  await deps.sendMessage(normalized, `Your WA Coexistence login code is ${code}. It expires in 5 minutes.`);
  await deps.setOtpDoc(normalized, { code, expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now });
  return { ok: true };
}

// watobot can take close to 60s to actually send (it queues per-account to
// avoid WhatsApp spam detection) — timeoutSeconds needs headroom above that,
// not Cloud Functions' 60s default, or this gets cut off before watobot
// itself would even time out.
export const sendOtp = onRequest({ timeoutSeconds: 90 }, (req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const db = getFirestore();
    try {
      const result = await sendOtpCore(req.body?.phone, {
        getOtpDoc: async (phone) => (await db.collection('otps').doc(phone).get()).data() as { lastSentAt?: number } | undefined,
        setOtpDoc: async (phone, data) => {
          await db.collection('otps').doc(phone).set(data);
        },
        sendMessage: (phone, message) => sendWhatsappMessage(config.watobotApiKey, phone, message),
      });
      res.status(result.ok ? 200 : 400).send(result);
    } catch (err) {
      // Without this, an exception (e.g. watobot unreachable) propagates out
      // of this callback uncaught — the response that produces has no CORS
      // headers (they're only set on the response we send ourselves), which
      // browsers surface as a misleading "blocked by CORS policy" error
      // instead of the real failure.
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});

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
