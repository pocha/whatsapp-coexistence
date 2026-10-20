import { HttpError, logEvent, post, type Handler } from './helpers/http';
import { authenticateKey, requireCaller } from './accounts';
import { listNotifications, listNumbersForUser, readNumber } from './helpers/model';
import { numberView, relayLimits } from './helpers/onboarding';
import { nextRefreshAt, refreshHealth } from './helpers/health';
import { REFRESH_MIN_INTERVAL_MS, presentHealth } from './helpers/sendGate';
import type { GetNumberResponse, ListNumbersResponse, NotificationsResponse } from './helpers/types';

// Reads for the dashboard and the MCP: what numbers an account has and where each stands. They
// answer the caller about their own numbers only, and never carry the stored token (numberView).

export const listNumbers: Handler = async (req, res) => {
  const userId = await requireCaller(req);
  const body: ListNumbersResponse = { ok: true, numbers: (await listNumbersForUser(userId)).map(numberView) };
  res.status(200).send(body);
};

export const getNumber: Handler = async (req, res) => {
  const userId = await requireCaller(req);
  const phoneNumberId = String(req.body?.phoneNumberId ?? '');
  const doc = phoneNumberId ? await readNumber(phoneNumberId) : undefined;
  // The same answer for a number that doesn't exist and one that is someone else's.
  if (!doc || doc.userId !== userId) throw new HttpError(404, 'Unknown phone number ID.');
  const body: GetNumberResponse = { ok: true, number: numberView(doc), limits: relayLimits(doc, Date.now()) };

  const now = Date.now();
  body.nextRefreshAt = nextRefreshAt(doc.metaFetchedAt, now);

  // Asking Meta (a refresh) needs the key, which opens the stored token, and is not done more than once in ten
  // minutes: a read without `refresh=true` only ever answers from what is stored, so it is safe to repeat.
  if (String(req.query?.refresh) === 'true') {
    if (req.body?.apiKey === undefined) throw new HttpError(401, 'Refreshing asks Meta with the stored token, so it needs the Watobot API key.');
    if (body.nextRefreshAt > now) {
      const retryAfterSeconds = Math.ceil((body.nextRefreshAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).send({ ...body, ok: false, error: `Meta was asked about this number ${Math.round((now - (doc.metaFetchedAt ?? now)) / 60000)} minutes ago. It can be asked again in ${Math.ceil(retryAfterSeconds / 60)} minutes: fix what the status names, then refresh.`, retryAfterSeconds });
      return;
    }
    try {
      const { accessToken } = await authenticateKey(phoneNumberId, req.body.apiKey);
      const { meta, derived } = await refreshHealth({ phoneNumberId, wabaId: doc.wabaId, accessToken });
      body.meta = meta;
      body.nextRefreshAt = now + REFRESH_MIN_INTERVAL_MS;
      if (derived) body.number = { ...body.number, health: presentHealth(derived.health, now), displayName: derived.displayName, metaFetchedAt: now };
    } catch (err) {
      body.metaError = (err as Error).message;
      logEvent('live details unavailable', { phoneNumberId, error: body.metaError });
    }
  }
  res.status(200).send(body);
};

/** A number's notifications, newest first: `?limit=` (up to 50) and `?before=` (an epoch ms) page back through them. */
export const getNotifications: Handler = async (req, res) => {
  const userId = await requireCaller(req);
  const phoneNumberId = String(req.body?.phoneNumberId ?? '');
  const doc = phoneNumberId ? await readNumber(phoneNumberId) : undefined;
  if (!doc || doc.userId !== userId) throw new HttpError(404, 'Unknown phone number ID.');
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));
  const before = Number(req.query?.before) || undefined;
  const { notifications, nextBefore } = await listNotifications(phoneNumberId, before, limit);
  const body: NotificationsResponse = { ok: true, notifications, ...(nextBefore ? { nextBefore } : {}) };
  res.status(200).send(body);
};
