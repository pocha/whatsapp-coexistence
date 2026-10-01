import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { exchangeCodeForToken, subscribeApp } from './graphApi';
import { requireAuth, HttpError } from './auth';

const corsHandler = cors({ origin: true });

// Exchanges the Embedded Signup `code` for an access token, then subscribes
// this app to the WABA, overriding the webhook straight to the business's
// own (already client-side-verified) endpoint. This is the one place the
// Meta App Secret is used, so it has to stay server-side.
//
// Returns the access token to the caller exactly once (see the send below) —
// it's never persisted here.
//
// Deliberately does NOT touch Firestore — by the time this succeeds, the
// caller (verified via requireAuth) is proven to administer the WABA
// (Meta wouldn't have issued a valid `code` otherwise), so the client
// writes the resulting wabas/{phoneNumberId} doc itself, straight to
// Firestore, gated by security rules. Keeps this function a pure Meta-API
// proxy instead of also being the source of truth for onboarding state.
export const completeOnboarding = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ error: 'Use POST' });
      return;
    }

    try {
      await requireAuth(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 401;
      res.status(status).send({ error: (err as Error).message });
      return;
    }

    const { code, wabaId, phoneNumberId, overrideCallbackUrl } = req.body ?? {};
    if (!code || !wabaId || !phoneNumberId || !overrideCallbackUrl) {
      res.status(400).send({ error: 'code, wabaId, phoneNumberId and overrideCallbackUrl are all required' });
      return;
    }

    try {
      const accessToken = await exchangeCodeForToken(code, config.metaAppId, config.metaAppSecret);
      await subscribeApp(wabaId, accessToken, overrideCallbackUrl, config.webhookVerifyToken);
      // Returned once so the business can keep it; never stored or logged here.
      res.status(200).send({ ok: true, wabaId, phoneNumberId, accessToken });
    } catch (err) {
      res.status(502).send({ error: (err as Error).message });
    }
  });
});
