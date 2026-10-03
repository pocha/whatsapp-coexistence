import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { requireAuth, HttpError } from './auth';
import { setFirstApiKey } from './accounts';

const corsHandler = cors({ origin: true });

// Records the hash of the API key a signed-in user just generated in their
// browser and confirmed they copied. Only works while the account has no key.
export const setApiKey = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }
    try {
      const userId = await requireAuth(req);
      await setFirstApiKey(userId, req.body?.apiKey);
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
