import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { exchangeCodeForToken } from './graphApi';
import { requireAuth, HttpError } from './auth';

const corsHandler = cors({ origin: true });

// Exchanges the Embedded Signup `code` for the WABA access token and hands it
// straight back to the signed-in caller, exactly once. The App Secret is
// needed for the exchange, which is why this runs server-side. The token is
// never stored or logged here; the business keeps it.
export const exchangeCode = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      await requireAuth(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 401;
      res.status(status).send({ ok: false, error: (err as Error).message });
      return;
    }

    const { code } = req.body ?? {};
    if (!code) {
      res.status(400).send({ ok: false, error: 'code is required' });
      return;
    }

    try {
      const accessToken = await exchangeCodeForToken(code, config.metaAppId, config.metaAppSecret);
      res.status(200).send({ ok: true, accessToken });
    } catch (err) {
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
