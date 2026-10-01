import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config';
import { sendWhatsappMessage } from './watobotApi';

const corsHandler = cors({ origin: true });
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
