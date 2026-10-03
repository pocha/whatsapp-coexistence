import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getAuth } from 'firebase-admin/auth';
import { requireAuth, HttpError } from './auth';
import { deleteAccount, resetApiKey, rotateApiKey } from './accounts';

const corsHandler = cors({ origin: true });

function handler(run: (userId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') {
        res.status(405).send({ ok: false, error: 'Use POST' });
        return;
      }
      try {
        const userId = await requireAuth(req);
        res.status(200).send({ ok: true, ...(await run(userId, req.body ?? {})) });
      } catch (err) {
        res.status(err instanceof HttpError ? err.status : 502).send({ ok: false, error: (err as Error).message });
      }
    });
  });
}

// Replace the API key. Needs the old key, and re-encrypts every stored token, so
// nothing is lost.
export const rotateKey = handler(async (userId, body) => ({
  rotated: await rotateApiKey(userId, body.oldApiKey, body.newApiKey),
}));

// For a lost key: deletes the stored tokens and the key hash. Each number must
// be onboarded again afterwards.
export const resetKey = handler(async (userId) => ({ wiped: await resetApiKey(userId) }));

// Deletes everything we hold for the user, including stored tokens.
export const deleteMyAccount = handler(async (userId) => {
  await deleteAccount(userId);
  await getAuth().deleteUser(userId).catch(() => undefined);
  return {};
});
