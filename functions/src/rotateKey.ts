import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { requireAuth, HttpError } from './auth';
import { rotateApiKey } from './accounts';

const corsHandler = cors({ origin: true });

// Replaces the signed-in user's API key. Needs the current key; every stored Meta token is
// re-encrypted under the new one. This runs server-side so the plaintext token is only ever
// in this function's memory, never in the browser.
export const rotateKey = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      const userId = await requireAuth(req);
      const { oldApiKey, newApiKey } = req.body ?? {};
      await rotateApiKey(userId, oldApiKey, newApiKey);
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
