import { onRequest } from 'firebase-functions/v2/https';
import cors from 'cors';
import { incrementWaitlist } from './helpers/model';

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

    try {
      const count = await incrementWaitlist();
      res.status(200).send({ ok: true, count });
    } catch (err) {
      res.status(502).send({ ok: false, error: (err as Error).message });
    }
  });
});
