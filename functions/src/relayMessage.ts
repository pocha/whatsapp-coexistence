import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { graphApiBase } from './graphApi';
import { authenticateKey } from './accounts';
import { HttpError } from './auth';

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

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// The actual product: a proxy in front of Meta's own /{phone-number-id}/messages
// endpoint. The caller authenticates with their Watobot API key, not a Meta
// token. We find their number, check the key, decrypt the Meta token we hold for
// it (in memory, for this request only) and forward the message body untouched.
//
// Because every send passes through here, usage is counted reliably, and rate
// limiting and per-recipient serialization (upcoming, see README) can be added
// in this one place.
app.post('/:phoneNumberId/messages', async (req, res) => {
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

export const relayMessage = onRequest(app);
