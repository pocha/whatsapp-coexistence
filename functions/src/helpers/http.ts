import { onRequest, type Request } from 'firebase-functions/v2/https';
import cors from 'cors';
import type { Response } from 'express';
import { HttpError } from './auth';

const corsHandler = cors({ origin: true });

type Handler = (req: Request, res: Response) => Promise<void>;

/** Wraps a POST handler: CORS, method check, and Meta or validation errors turned into a JSON answer. */
export function post(handler: Handler, options: { timeoutSeconds?: number } = {}) {
  return onRequest(options, (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') {
        res.status(405).send({ ok: false, error: 'Use POST' });
        return;
      }
      try {
        await handler(req, res);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 502;
        res.status(status).send({ ok: false, error: (err as Error).message });
      }
    });
  });
}
