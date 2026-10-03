import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import cors from 'cors';
import { requireAuth, HttpError } from './auth';
import { requireUserKey } from './accounts';
import { decryptToken, encryptToken, hashApiKey, isValidApiKey, type EncryptedToken } from './apiKey';

const corsHandler = cors({ origin: true });

// Replaces the signed-in user's API key. Needs the current key; every stored Meta token is
// re-encrypted under the new one, and the new hash is saved, in one atomic batch. This runs
// server-side so the plaintext token is only ever in this function's memory, never in the browser.
export const rotateKey = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    try {
      const userId = await requireAuth(req);
      const { oldApiKey, newApiKey } = req.body ?? {};
      await requireUserKey(userId, oldApiKey);
      if (!isValidApiKey(newApiKey)) throw new HttpError(400, 'That is not a valid new API key.');

      const db = getFirestore();
      const batch = db.batch();
      (await db.collection('phoneNumbers').where('userId', '==', userId).get()).forEach((snap) => {
        const enc = snap.data().encAccessToken as EncryptedToken | undefined;
        if (!enc) return;
        let token: string;
        try {
          token = decryptToken(enc, oldApiKey);
        } catch {
          throw new HttpError(500, 'Could not decrypt a stored access token.');
        }
        batch.update(snap.ref, { encAccessToken: encryptToken(token, newApiKey) });
      });
      batch.update(db.collection('users').doc(userId), { apiKeyHash: hashApiKey(newApiKey), rotatedAt: Date.now() });
      await batch.commit();
      res.status(200).send({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      res.status(status).send({ ok: false, error: (err as Error).message });
    }
  });
});
