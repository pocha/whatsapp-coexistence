import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { config } from './config';
import { requireAuth, HttpError } from './auth';

const corsHandler = cors({ origin: true });

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Hits the business's own endpoint with the exact same GET verification
 * handshake Meta itself performs (hub.mode/hub.verify_token/hub.challenge)
 * before we ever call subscribed_apps with it as the override. Catches a
 * broken/misconfigured endpoint before it becomes Meta's problem.
 *
 * Pulled out of the onRequest handler so it's directly unit-testable without
 * needing to invoke the wrapped Cloud Function object.
 */
export async function verifyEndpointChallenge(url: string | undefined, verifyToken: string): Promise<CheckResult> {
  if (!url) return { ok: false, error: 'url is required' };
  if (!url.startsWith('https://')) {
    return { ok: false, error: 'Endpoint must be HTTPS — Meta requires it for webhooks.' };
  }

  const challenge = Math.random().toString(36).slice(2);
  const verifyUrl = new URL(url);
  verifyUrl.searchParams.set('hub.mode', 'subscribe');
  verifyUrl.searchParams.set('hub.verify_token', verifyToken);
  verifyUrl.searchParams.set('hub.challenge', challenge);

  try {
    const fetchRes = await fetch(verifyUrl, { signal: AbortSignal.timeout(8000) });
    const text = (await fetchRes.text()).trim();
    if (fetchRes.status === 200 && text === challenge) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Endpoint responded ${fetchRes.status} with body "${text.slice(0, 200)}" — expected 200 echoing back the challenge string unchanged.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not reach endpoint: ${(err as Error).message}` };
  }
}

// Requires sign-in (not because the check itself is sensitive, but because
// it makes an outbound fetch to a caller-supplied URL — an anonymous open
// endpoint doing that is an easy SSRF/scanning target).
export const checkEndpoint = onRequest((req, res) => {
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

    const result = await verifyEndpointChallenge(req.body?.url, config.webhookVerifyToken);
    res.status(200).send(result);
  });
});
