import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { subscribeApp } from './graphApi';
import { verifyEndpointChallenge } from './endpointCheck';
import { authenticateKey } from './accounts';
import { HttpError } from './auth';

const corsHandler = cors({ origin: true });

// Points a number's WABA at the business's own incoming-message endpoint.
//
// No sign-in: the Watobot API key is the credential. It is checked against the
// account first, so only the key's holder can make us fetch the supplied URL (an
// open version of that would be an SSRF / scanning target). The stored Meta token
// is decrypted in memory for this one request.
//
// Does not write to Firestore. The frontend records the new URL only if this
// call succeeds and the user is signed in.
export const setWebhook = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const { phoneNumberId, apiKey, overrideCallbackUrl } = req.body ?? {};
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
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
