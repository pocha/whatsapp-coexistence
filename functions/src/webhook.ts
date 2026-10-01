import { onRequest } from 'firebase-functions/v2/https';
import { config } from './config';

// Meta requires an app-level webhook URL to be configured regardless of
// whether any given WABA overrides it — this is that fallback. In the real
// coexistence flow every onboarded WABA sets override_callback_uri (see
// completeOnboarding.ts), so Meta delivers incoming events straight to the
// business's own server and this handler never sees them.
export const webhook = onRequest((req, res) => {
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
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
});
