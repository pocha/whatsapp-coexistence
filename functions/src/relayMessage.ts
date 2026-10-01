import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { graphApiBase } from './graphApi';

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

// The actual product: a stateless proxy in front of Meta's own
// /{phone-number-id}/messages endpoint. The caller supplies their OWN
// permanent WhatsApp access token (via Authorization) on every call — we
// never store it, just forward it straight through to Meta alongside their
// message body. That's what keeps this consistent with "no token storage":
// the token never outlives a single request.
//
// This is intentionally a dumb passthrough for now. Rate limiting and
// per-recipient serialization (the reasons to route sends through us at
// all, instead of calling Meta directly) are upcoming — see README.
//
// Attribution for billing doesn't need a separate API key: Meta itself only
// lets a token successfully send through a phoneNumberId it's actually
// authorized for, so a successful call already proves the caller controls
// that number. We just look up wabas/{phoneNumberId} to find who to credit.
app.post('/:phoneNumberId/messages', async (req, res) => {
  const { phoneNumberId } = req.params;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your WhatsApp access token>' });
    return;
  }

  const metaRes = await fetch(`${graphApiBase()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(10000),
  });
  const body = await metaRes.json();

  // Metadata only — timestamp + outcome, never the message content or
  // token — and only successful sends count toward billable usage.
  //
  // Uses update() rather than set(merge:true) on purpose: it fails instead
  // of creating a doc if phoneNumberId isn't an actual onboarded WABA, so a
  // probe with a bogus phoneNumberId can't pollute Firestore with orphan
  // ownerUid-less documents. That failure is swallowed — bookkeeping is
  // best-effort and shouldn't affect the response the caller sees.
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
    await getFirestore().collection('wabas').doc(phoneNumberId).update(update);
  } catch {
    // No such WABA doc — nothing to record against.
  }

  res.status(metaRes.status).send(body);
});

export const relayMessage = onRequest(app);
