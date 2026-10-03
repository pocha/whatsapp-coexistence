import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { config } from './helpers/config';
import { graphApiBase, subscribeApp } from './helpers/graphApi';
import { verifyEndpointChallenge } from './helpers/endpointCheck';
import { HttpError } from './helpers/auth';
import type { SetWebhookRequest } from './helpers/types';
import { authenticateKey } from './accounts';

// What a customer does with a number through its Watobot API key: set where incoming
// messages go (setWebhook), send messages (relayMessage) and manage message templates
// (templates). Each one finds the number, checks the key, decrypts the stored Meta token
// in memory for the request, and calls Meta with it.

const corsHandler = cors({ origin: true });

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

      const check = await verifyEndpointChallenge(overrideCallbackUrl, config.webhookVerifyToken);
      if (!check.ok) {
        res.status(400).send(check);
        return;
      }

      await subscribeApp(wabaId, accessToken, overrideCallbackUrl, config.webhookVerifyToken);
      await getFirestore()
        .collection('phoneNumbers')
        .doc(String(phoneNumberId))
        .update({ overrideUrl: overrideCallbackUrl, activatedAt: Date.now() });
      res.status(200).send({ ok: true });
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

export const templates = onRequest(templatesApp);
