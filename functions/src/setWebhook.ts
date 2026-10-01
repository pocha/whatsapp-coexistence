import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { subscribeApp, verifyWabaAccess } from './graphApi';
import { verifyEndpointChallenge } from './endpointCheck';

const corsHandler = cors({ origin: true });

// Points a WABA's incoming messages at the business's own endpoint.
//
// No sign-in: the business's access token is the credential. It is checked
// against Meta first, so only someone holding a valid token for this WABA can
// make us fetch the supplied URL (an open version of that would be an SSRF /
// scanning target). The token is used for this one request and never stored.
//
// Does not write to Firestore. The frontend records the new URL only if this
// call succeeds and the user is signed in.
export const setWebhook = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const { wabaId, accessToken, overrideCallbackUrl } = req.body ?? {};
    if (!wabaId || !accessToken || !overrideCallbackUrl) {
      res.status(400).send({ ok: false, error: 'wabaId, accessToken and overrideCallbackUrl are all required' });
      return;
    }

    try {
      await verifyWabaAccess(wabaId, accessToken);
    } catch (err) {
      res.status(401).send({ ok: false, error: `That access token can't access this WABA. ${(err as Error).message}` });
      return;
    }

    const check = await verifyEndpointChallenge(overrideCallbackUrl, config.webhookVerifyToken);
    if (!check.ok) {
      res.status(400).send(check);
      return;
    }

    try {
      await subscribeApp(wabaId, accessToken, overrideCallbackUrl, config.webhookVerifyToken);
      res.status(200).send({ ok: true });
    } catch (err) {
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
