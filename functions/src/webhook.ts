import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './helpers/config';

// Meta requires an app-level webhook URL to be configured regardless of
// whether any given WABA overrides it: this is that fallback. In the real
// coexistence flow every onboarded WABA sets override_callback_uri (see
// wabaManager.ts), so Meta delivers incoming messages straight to the
// business's own server. What can't be overridden (template and account-level
// updates) arrives here, and is acknowledged and left alone: Meta emails the
// account's admins about the ones that matter.

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
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
});
