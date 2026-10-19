import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { config } from './helpers/config';
import { applyEffects, parseWebhook } from './helpers/gateEvents';
import { addNotification, numbersForWaba, updateGates } from './helpers/model';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

/** Stores what Meta sent and applies it to the numbers it is about. Each event is handled on its own, so one failure loses no other. */
export async function handleWebhookBody(body: unknown, now = Date.now()): Promise<number> {
  let handled = 0;
  for (const event of parseWebhook(body)) {
    try {
      const numbers = await numbersForWaba(event.wabaId);
      // An account normally holds one number; if it holds several, a number-level event names which.
      const targets = event.displayPhone && numbers.length > 1 ? numbers.filter((n) => digits(n.displayPhoneNumber) === digits(event.displayPhone)) : numbers;
      if (!targets.length) {
        logger.info('webhook event for an account we do not hold', { field: event.field, event: event.event });
        continue;
      }
      for (const number of targets) {
        // The same event delivered twice has the same id, so it is stored once.
        const id = createHash('sha1').update(`${event.wabaId}|${event.field}|${event.eventAt}|${JSON.stringify(event.value)}`).digest('hex');
        await addNotification(number.phoneNumberId, id, { eventAt: event.eventAt, receivedAt: now, field: event.field, event: event.event, ...event.notification, value: event.value });
        if (event.effects.length) await updateGates(number.phoneNumberId, (doc) => applyEffects(doc, event.effects, event.eventAt, now));
        handled += 1;
      }
    } catch (err) {
      logger.error('webhook event failed', { field: event.field, error: (err as Error).message });
    }
  }
  return handled;
}

// Meta requires an app-level webhook URL to be configured regardless of
// whether any given WABA overrides it: this is that fallback. In the real
// coexistence flow every onboarded WABA sets override_callback_uri (see
// wabaManager.ts), so Meta delivers incoming messages straight to the
// business's own server. What can't be overridden (template and account-level
// updates) arrives here. Those are kept as the number's Notifications and, where
// they bear on whether a send should go out, applied to its gates (helpers/gateEvents.ts).
// Messages, syncs and echoes are never read or kept.

/**
 * Meta signs every webhook with the app secret: `X-Hub-Signature-256: sha256=<hex>`, an HMAC of the
 * raw request body. Anything without a matching signature did not come from Meta for this app.
 */
export function signatureMatches(rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.metaAppSecret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export const webhook = onRequest((req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
      res.status(200).send(challenge);
      return;
    }
    logger.warn('webhook verification refused', { mode });
    res.status(403).send('Forbidden');
    return;
  }

  if (req.method === 'POST') {
    if (!signatureMatches(req.rawBody, req.header('x-hub-signature-256'))) {
      logger.warn('webhook signature rejected', { signed: Boolean(req.header('x-hub-signature-256')) });
      res.status(401).send('Invalid signature');
      return;
    }
    logger.info('webhook event', { object: req.body?.object, fields: (req.body?.entry ?? []).flatMap((e: any) => (e.changes ?? []).map((c: any) => c.field)) });
    handleWebhookBody(req.body).then(
      () => res.status(200).send('EVENT_RECEIVED'),
      // Meta retries on a failure, and the events are stored under stable ids, so a retry does no harm.
      (err) => {
        logger.error('webhook failed', { error: (err as Error).message });
        res.status(500).send('Failed');
      },
    );
    return;
  }

  res.status(405).send('Method not allowed');
});
