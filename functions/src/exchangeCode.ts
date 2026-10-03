import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { exchangeCodeForToken } from './graphApi';
import { requireAuth, HttpError } from './auth';
import { requireUserKey, storeWabaToken } from './accounts';

const corsHandler = cors({ origin: true });
const ID_RE = /^\d{1,32}$/;

// Exchanges the Embedded Signup `code` for the customer's Meta access token and
// stores it encrypted under the signed-in user's Watobot API key. The App Secret
// is needed for the exchange, which is why this runs server-side. The plaintext
// token only lives in memory for this request: it is never returned, stored or
// logged in the clear.
export const exchangeCode = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      const userId = await requireAuth(req);
      const { code, wabaId, phoneNumberId, apiKey } = req.body ?? {};
      if (!code || !ID_RE.test(String(wabaId)) || !ID_RE.test(String(phoneNumberId))) {
        throw new HttpError(400, 'code, wabaId and phoneNumberId are required.');
      }
      await requireUserKey(userId, apiKey);

      const accessToken = await exchangeCodeForToken(code, config.metaAppId, config.metaAppSecret);
      await storeWabaToken({ userId, wabaId: String(wabaId), phoneNumberId: String(phoneNumberId), accessToken, apiKey });
      res.status(200).send({ ok: true, wabaId, phoneNumberId });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
