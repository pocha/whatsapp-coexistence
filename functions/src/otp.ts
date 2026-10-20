import cors from 'cors';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { apiKeyMatchesHash, isValidApiKey } from './helpers/apiKey';
import { config } from './helpers/config';
import { type UserRecord, countOtpAttempt, deleteOtp, getOrCreateUserByPhone, readOtp, resetApiKey, saveOtp } from './helpers/model';

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

  // The reviewers' login: a fixed code and no message (see TEST_LOGIN below).
  const isTestLogin = normalized === TEST_LOGIN.phone;

  const existing = await deps.getOtpDoc(normalized);
  const now = Date.now();
  if (!isTestLogin && existing?.lastSentAt && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
    return { ok: false, error: `Wait ${waitSec}s before requesting another code.` };
  }

  const code = isTestLogin ? TEST_LOGIN.code : generateCode();
  if (!isTestLogin) {
    await deps.sendMessage(normalized, otpMessage(code, pickOtpFact()));
  }
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

    try {
      const result = await sendOtpCore(req.body?.phone, {
        getOtpDoc: async (phone) => readOtp<{ lastSentAt?: number }>(phone),
        setOtpDoc: async (phone, data) => {
          await saveOtp(phone, data);
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
      logger.error('sendOtp failed', { error: (err as Error).message });
      logger.error('verifyOtp failed', { error: (err as Error).message });
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

    try {
      const result = await verifyOtpCore(
        req.body?.phone,
        req.body?.code,
        { apiKey: req.body?.apiKey, resetApiKey: req.body?.resetApiKey === true },
        {
          getOtpDoc: async (phone) => readOtp<OtpDoc>(phone),
          deleteOtpDoc: async (phone) => {
            await deleteOtp(phone);
          },
          incrementAttempts: async (phone) => {
            await countOtpAttempt(phone);
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


// Login codes go out through an API that flags a repeated message to the same
// recipient as a duplicate. One random fact per message keeps each one different.
// Three facts per how-to page (and the capabilities page); each restates something
// that page already says, so the pointer to the how-to section holds up.
export const OTP_FACTS: string[] = [
  // create-meta-business-portfolio-add-whatsapp-number
  'You need a Meta business portfolio to use the WhatsApp API, but it can stay unverified.',
  'One Facebook account can own several business portfolios.',
  'Your WhatsApp Business app must be installed and logged in before you link the number to a portfolio.',
  // get-whatsapp-api-for-free
  'Meta describes the token from the WhatsApp setup page as a permanent access token.',
  'Pick the "Connect with customers through WhatsApp" use case when you create the Meta app.',
  'An API for your own number runs on Standard Access, so no App Review is needed.',
  // get-whatsapp-api-access-in-5-minutes
  'Coexistence keeps the WhatsApp Business app and the API working on one number.',
  'With coexistence, your contacts and chat history sync to the API once, within 24 hours.',
  'Coexistence needs no verified business.',
  // move-whatsapp-api-between-providers
  'Under Meta\'s new account model, templates belong to the Messaging account, not the phone number.',
  'Disconnecting from a provider does not delete your templates.',
  'You can only move or share a WhatsApp account that your own business portfolio owns.',
  // questions-to-ask-whatsapp-api-provider
  'Meta charges per delivered message, and never for messages your customers send.',
  'An unverified business starts at 250 customers a day, and messaging limits count customers, not messages.',
  'Ask whether your provider supports coexistence: the number has to be on the Business app when it connects.',
  // deregister-whatsapp-number-from-provider
  'De-registering a number does not delete it or its chat history.',
  'A coexistence number is disconnected in the Business app: Settings, Account, Business Platform.',
  'Registering a number for the API needs a six-digit PIN.',
  // whatsapp-number-registration-and-pin
  'The six-digit registration PIN is one you choose yourself.',
  'Meta can pause a template after negative feedback from customers.',
  'Template review can take up to 24 hours.',
  // connect-watobot-to-ai-tool
  'Watobot never stores your messages.',
  'Your Meta token is encrypted with your Watobot key, and only a hash of that key is kept.',
  'Your Watobot key is created in your browser and shown once.',
  // capabilities
  'A free-form reply is only allowed within 24 hours of the customer\'s last message.',
  'Messages you type in the Business app reach your API as echoes.',
  'Watobot shows Meta\'s account alerts and sending limits on your dashboard.',
];

export function pickOtpFact(random: () => number = Math.random): string {
  return OTP_FACTS[Math.floor(random() * OTP_FACTS.length)];
}

export function otpMessage(code: string, fact: string): string {
  return (
    `Your Watobot OTP to login is ${code}. It expires in 5 minutes. Don't share this code with anyone.\n\n` +
    `Fun fact: ${fact}\nFor more such interesting facts, check the how-to section of the Watobot website.`
  );
}


// A fixed login for reviewers (Meta's App Review needs a way to sign in without receiving a
// WhatsApp message). For this one number the code is always TEST_LOGIN.code and no message is
// sent; every other number gets a real one-time code as usual.
//
// Treat the account behind it as public: give it only demo data, never a real customer's number.
// Delete this file's values (or the lines in otp.ts that read them) once review is done.
// `phone` is digits only, as the login page normalises numbers (+1 234 567 8901).
export const TEST_LOGIN = { phone: '12345678901', code: '123456' };


// Sends the login OTP over WhatsApp via watobot.xyz (mudbot), so login needs
// no email/Facebook — just a WhatsApp number the business already has.
// https://github.com/pocha/mudbot
const WATOBOT_BASE = process.env.WATOBOT_API_BASE || 'https://api.watobot.xyz';

export async function sendWhatsappMessage(apiKey: string, to: string, message: string): Promise<void> {
  const res = await fetch(`${WATOBOT_BASE}/api/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ to, message }),
    // watobot queues messages per-account to avoid WhatsApp spam detection
    // (see mudbot's docs), so a send can genuinely take ~60s — this needs
    // real headroom above that, not a generic request timeout.
    signal: AbortSignal.timeout(75_000),
  });

  const body = (await res.json().catch(() => ({}))) as { success?: boolean; reason?: string };
  if (!res.ok || !body.success) {
    throw new Error(`watobot send failed: ${res.status} ${body.reason ?? JSON.stringify(body)}`);
  }
}
