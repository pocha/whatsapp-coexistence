import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { config } from './helpers/config';
import { getDisplayPhoneNumber, getPhoneNumberInfo, graphApiBase, registerPhoneNumber, subscribeApp } from './helpers/graphApi';
import { effectiveConfig, limitsView, reserve, UNITS, type RateState, type Verdict } from './helpers/rateLimiter';
import type { RateLimitConfig } from './helpers/rateLimitConfig';
import { verifyEndpointChallenge } from './helpers/endpointCheck';
import { HttpError } from './helpers/auth';
import type { OnboardingResponse, PhoneNumberDoc, RegisterNumberRequest, RelayLimitsResponse, SetWebhookRequest } from './helpers/types';
import { authenticateKey } from './accounts';
import { advanceAfterOverride, importTemplatesFor, migrateTemplatesFor, movedTo, noteOnboardingError } from './onboarding';
import { effectiveStep } from './helpers/onboardingSteps';

// What a customer does with a number through its Watobot API key: set where incoming
// messages go (setWebhook), register a new number (registerNumber), send messages
// (relayMessage) and manage message templates
// (templates). Each one finds the number, checks the key, decrypts the stored Meta token
// in memory for the request, and calls Meta with it.

const corsHandler = cors({ origin: true });

/** Saves how the number is shown (best-effort; the sidebar falls back to the phone number ID). */
async function rememberDisplayNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  try {
    const displayPhoneNumber = await getDisplayPhoneNumber(phoneNumberId, accessToken);
    if (displayPhoneNumber) {
      await getFirestore().collection('phoneNumbers').doc(phoneNumberId).update({ displayPhoneNumber });
    }
  } catch {
    // The sidebar falls back to the phone number ID.
  }
}

// ---- setWebhook ----

// Points a number's WABA at the business's own incoming-message endpoint.
//
// No sign-in: the Watobot API key is the credential. It is checked against the
// account first, so only the key's holder can make us fetch the supplied URL (an
// open version of that would be an SSRF / scanning target). The stored Meta token
// is decrypted in memory for this one request.
//
// On success the new URL is recorded on the number's record, so the Dashboard can show
// it. The browser never writes it.
export const setWebhook = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const { phoneNumberId, apiKey, overrideCallbackUrl } = (req.body ?? {}) as Partial<SetWebhookRequest>;
    if (!phoneNumberId || !apiKey || !overrideCallbackUrl) {
      res.status(400).send({ ok: false, error: 'phoneNumberId, apiKey and overrideCallbackUrl are all required' });
      return;
    }

    try {
      const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);

      try {
        const check = await verifyEndpointChallenge(overrideCallbackUrl, config.webhookVerifyToken);
        if (!check.ok) throw new HttpError(400, check.error!);

        await subscribeApp(wabaId, accessToken, overrideCallbackUrl, config.webhookVerifyToken);
        await getFirestore()
          .collection('phoneNumbers')
          .doc(String(phoneNumberId))
          .update({ overrideUrl: overrideCallbackUrl, activatedAt: Date.now() });
        await rememberDisplayNumber(String(phoneNumberId), accessToken);

        // A number in the onboarding wizard moves on from here; a finished one just gets its new URL.
        const doc = (await getFirestore().collection('phoneNumbers').doc(String(phoneNumberId)).get()).data() as PhoneNumberDoc;
        if (doc.onboarding.step === 'override') {
          const next = await advanceAfterOverride(String(phoneNumberId), accessToken);
          const body: OnboardingResponse = { ok: true, ...next };
          res.status(200).send(body);
          return;
        }
        res.status(200).send({ ok: true });
      } catch (err) {
        await noteOnboardingError(String(phoneNumberId), 'override', (err as Error).message);
        throw err;
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});

// ---- registerNumber ----

// Registers a number for Cloud API use after Embedded Signup, which a brand-new (not
// coexistence) number needs before it can send or receive. Same auth as setWebhook: the
// Watobot API key, no sign-in. Meta's error is returned as is, so a failure says why.
// timeoutSeconds leaves room for Meta's slow register call (see registerPhoneNumber).
export const registerNumber = onRequest({ timeoutSeconds: 90 }, (req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const { phoneNumberId, apiKey, pin } = (req.body ?? {}) as Partial<RegisterNumberRequest>;
    if (!phoneNumberId || !apiKey || !/^\d{6}$/.test(String(pin ?? ''))) {
      res.status(400).send({ ok: false, error: 'phoneNumberId, apiKey and a 6-digit pin are required' });
      return;
    }

    try {
      const { accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
      try {
        // A number that is also on the WhatsApp Business app is already registered. Registering it
        // for the API alone would take it off the app, so it is refused.
        const info = await getPhoneNumberInfo(String(phoneNumberId), accessToken);
        if (info.isOnBizApp === true) {
          throw new HttpError(409, 'This number is on the WhatsApp Business app, which already registers it. Registering it for the API alone would take it off the app, so it is not done.');
        }
        await registerPhoneNumber(String(phoneNumberId), accessToken, String(pin));
      } catch (err) {
        await noteOnboardingError(String(phoneNumberId), 'register', (err as Error).message);
        throw err;
      }
      await rememberDisplayNumber(String(phoneNumberId), accessToken);

      const ref = getFirestore().collection('phoneNumbers').doc(String(phoneNumberId));
      const doc = (await ref.get()).data() as PhoneNumberDoc;
      await ref.update({ metaStatus: 'CONNECTED' });
      // The API-only path of the wizard continues with templates once the number is registered.
      if (doc.onboarding.step === 'register') {
        await ref.update({ onboarding: movedTo(doc.onboarding, 'templates') });
      }
      const body: OnboardingResponse = { ok: true, step: effectiveStep((await ref.get()).data() as PhoneNumberDoc) };
      res.status(200).send(body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});

// ---- relayMessage ----

export function dailyKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function monthlyKey(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Counts one more template message against the number's windows, and says whether it may go. The
 * check and the count happen in one transaction, so sends arriving together cannot all slip under
 * the limit. Limits come from helpers/rateLimitConfig.ts, overridden per number by `rateLimits`.
 */
async function reserveTemplateSend(phoneNumberId: string): Promise<{ verdict: Verdict | { allowed: true }; config: RateLimitConfig; now: number }> {
  const db = getFirestore();
  const ref = db.collection('phoneNumbers').doc(phoneNumberId);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() as PhoneNumberDoc | undefined;
    const config = effectiveConfig(data?.rateLimits);
    if (!config.enabled) return { verdict: { allowed: true as const }, config, now };
    const verdict = reserve(data?.rateState, config, now);
    tx.update(ref, { rateState: verdict.state });
    return { verdict, config, now };
  });
}

/** What is left in each window and when it resets, as headers on a template send, so a sender can pace itself. */
function setRateHeaders(res: express.Response, state: RateState, config: RateLimitConfig, now: number) {
  const windows = limitsView(state, config, now);
  for (const unit of UNITS) {
    const name = unit[0].toUpperCase() + unit.slice(1);
    res.set(`X-RateLimit-Remaining-${name}`, String(windows[unit].remaining));
    res.set(`X-RateLimit-Reset-${name}`, String(Math.ceil(windows[unit].resetsAt / 1000)));
  }
}

const relayApp = express();
relayApp.use(cors({ origin: true }));
relayApp.use(express.json());

// The actual product: a proxy in front of Meta's own /{phone-number-id}/messages
// endpoint. The caller authenticates with their Watobot API key, not a Meta
// token. We find their number, check the key, decrypt the Meta token we hold for
// it (in memory, for this request only) and forward the message body untouched.
//
// Because every send passes through here, usage is counted reliably, and rate
// limiting and per-recipient serialization (upcoming, see README) can be added
// in this one place.
relayApp.post('/:phoneNumberId/messages', async (req, res) => {
  const { phoneNumberId } = req.params;
  const authHeader = req.headers.authorization;
  const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }

  let accessToken: string;
  try {
    ({ accessToken } = await authenticateKey(phoneNumberId, key));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).send({ error: (err as Error).message });
    return;
  }

  // Only template messages are limited; free-form replies go straight through.
  if (req.body?.type === 'template') {
    const { verdict, config, now } = await reserveTemplateSend(phoneNumberId);
    if ('state' in verdict) setRateHeaders(res, verdict.state, config, now);
    if (!verdict.allowed && 'unit' in verdict) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      res.status(429).send({
        error: `Rate limit reached: ${verdict.current} template messages this ${verdict.unit} (limit ${verdict.limit}). Try again in ${verdict.retryAfterSeconds}s.`,
        window: verdict.unit,
        limit: verdict.limit,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }
  }

  const metaRes = await fetch(`${graphApiBase()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(10000),
  });
  const body = await metaRes.json();

  // Metadata only — timestamp + outcome, never the message content or any
  // token — and only successful sends count toward billable usage. Uses update()
  // so a failure never creates a record. Any failure is swallowed: bookkeeping
  // is best-effort and shouldn't affect the response the caller sees.
  const now = new Date();
  const update: Record<string, unknown> = {
    lastRelayCall: { at: now.getTime(), ok: metaRes.ok, statusCode: metaRes.status },
  };
  if (metaRes.ok) {
    update[`usage.daily.${dailyKey(now)}`] = FieldValue.increment(1);
    update[`usage.weekly.${isoWeekKey(now)}`] = FieldValue.increment(1);
    update[`usage.monthly.${monthlyKey(now)}`] = FieldValue.increment(1);
  }
  try {
    await getFirestore().collection('phoneNumbers').doc(phoneNumberId).update(update);
  } catch {
    // No record to update.
  }

  res.status(metaRes.status).send(body);
});

// Where the number stands against its template-send limits, so a sender (or an AI tool) can pace
// itself: per window what went through, what is left and when it resets.
relayApp.get('/:phoneNumberId/limits', async (req, res) => {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ ok: false, error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    await authenticateKey(req.params.phoneNumberId, key);
    const data = (await getFirestore().collection('phoneNumbers').doc(req.params.phoneNumberId).get()).data() as PhoneNumberDoc;
    const config = effectiveConfig(data.rateLimits);
    const now = Date.now();
    const windows = limitsView(data.rateState, config, now);
    const body: RelayLimitsResponse = {
      ok: true,
      appliesTo: 'template messages',
      enabled: config.enabled,
      windows: Object.fromEntries(
        UNITS.map((unit) => [
          unit,
          { ...windows[unit], resetsAt: new Date(windows[unit].resetsAt).toISOString(), resetsInSeconds: Math.max(1, Math.ceil((windows[unit].resetsAt - now) / 1000)) },
        ]),
      ) as RelayLimitsResponse['windows'],
    };
    res.status(200).send(body);
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).send({ ok: false, error: (err as Error).message });
  }
});

export const relayMessage = onRequest(relayApp);

// ---- templates ----

const templatesApp = express();
templatesApp.use(cors({ origin: true }));
templatesApp.use(express.json());

// Message template list / create / edit / delete for a number's WABA, using the stored
// Meta token. Same auth as the relay: `Authorization: Bearer <Watobot API key>`.
// Meta's response and status are returned unchanged.
async function forward(
  req: express.Request,
  res: express.Response,
  method: 'GET' | 'POST' | 'DELETE',
  query: string,
  body?: unknown,
  templateId?: string,
) {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    const { wabaId, accessToken } = await authenticateKey(req.params.phoneNumberId, key);
    // Editing posts to the template's own id; everything else works on the WABA's collection.
    const target = templateId ?? `${wabaId}/message_templates`;
    const metaRes = await fetch(`${graphApiBase()}/${target}${query}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    res.status(metaRes.status).send(await metaRes.json().catch(() => ({})));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).send({ error: (err as Error).message });
  }
}

templatesApp.get('/:phoneNumberId', (req, res) =>
  forward(req, res, 'GET', '?fields=id,name,status,category,language,components&limit=100'),
);
templatesApp.post('/:phoneNumberId', (req, res) => forward(req, res, 'POST', '', req.body));
// Bring templates across from another Messaging account, or from a list exported elsewhere.
async function withKeyAnswer(req: express.Request, res: express.Response, run: (key: string) => Promise<object>) {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ ok: false, error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    res.status(200).send(await run(key));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).send({ ok: false, error: (err as Error).message });
  }
}
templatesApp.post('/:phoneNumberId/migrate', (req, res) =>
  withKeyAnswer(req, res, (key) => migrateTemplatesFor(req.params.phoneNumberId, key, req.body?.sourceWabaId)),
);
templatesApp.post('/:phoneNumberId/import', (req, res) =>
  withKeyAnswer(req, res, (key) => importTemplatesFor(req.params.phoneNumberId, key, req.body?.templates)),
);
templatesApp.post('/:phoneNumberId/:templateId', (req, res) => {
  if (!/^\d+$/.test(req.params.templateId)) {
    res.status(400).send({ error: 'The template id is the number from the list response.' });
    return;
  }
  forward(req, res, 'POST', '', req.body, req.params.templateId);
});
templatesApp.delete('/:phoneNumberId', (req, res) =>
  forward(req, res, 'DELETE', `?name=${encodeURIComponent(String(req.query.name ?? ''))}`),
);

// Importing creates templates one at a time, which can take a while.
export const templates = onRequest({ timeoutSeconds: 300 }, templatesApp);
