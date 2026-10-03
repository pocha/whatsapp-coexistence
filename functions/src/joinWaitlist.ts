import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { getFirestore } from 'firebase-admin/firestore';

const corsHandler = cors({ origin: true });

// Counts a click on the landing page's "Join Waitlist" button. No email or
// other personal data is received or stored: only the running total, in
// meta/waitlist, which pages read directly (rules make it public and
// read-only) so a browser can't edit it. The increment runs in a transaction
// so simultaneous clicks are all counted.
export const joinWaitlist = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send({ ok: false, error: 'Use POST' });
      return;
    }

    const db = getFirestore();
    try {
      const count = await db.runTransaction(async (tx) => {
        const counter = db.collection('meta').doc('waitlist');
        const current = ((await tx.get(counter)).data()?.count as number | undefined) ?? 0;
        tx.set(counter, { count: current + 1 });
        return current + 1;
      });
      res.status(200).send({ ok: true, count });
    } catch (err) {
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
