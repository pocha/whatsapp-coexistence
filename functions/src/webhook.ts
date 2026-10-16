import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { config } from './helpers/config';
import { digitsOf, reputationUpdates, type ReputationUpdate } from './helpers/reputation';
import type { PhoneNumberDoc } from './helpers/types';

// Meta requires an app-level webhook URL to be configured regardless of
// whether any given WABA overrides it — this is that fallback. In the real
// coexistence flow every onboarded WABA sets override_callback_uri (see
// wabaManager.ts), so Meta delivers incoming messages straight to the
// business's own server. But template and account-level webhooks can't be
// overridden, so those always arrive here: the quality and status ones are kept
// on the numbers they concern (helpers/reputation.ts) for the dashboard.

/** Writes one update to every number on the Messaging account it came in on. */
async function apply(update: ReputationUpdate): Promise<void> {
  const numbers = await getFirestore().collection('phoneNumbers').where('wabaId', '==', update.wabaId).get();
  for (const snap of numbers.docs) {
    const doc = snap.data() as PhoneNumberDoc;
    if (update.displayPhoneNumber && doc.displayPhoneNumber && digitsOf(update.displayPhoneNumber) !== digitsOf(doc.displayPhoneNumber)) continue;
    if (update.onlyIfTracked) {
      const tracked = doc.reputation?.templates?.[update.onlyIfTracked];
      if (!tracked) continue;
    }
    const changes: Record<string, unknown> = { ...update.set };
    for (const path of update.remove) changes[path] = FieldValue.delete();
    if (Object.keys(changes).length) await snap.ref.update(changes);
  }
}

export const webhook = onRequest(async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
    return;
  }

  if (req.method === 'POST') {
    try {
      for (const update of reputationUpdates(req.body)) await apply(update);
    } catch (err) {
      // Meta retries on an error status, which would not help a bad payload; log it and acknowledge.
      console.error('webhook: could not apply an update', (err as Error).message);
    }
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
});
