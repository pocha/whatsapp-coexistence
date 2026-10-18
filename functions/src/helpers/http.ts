import { onRequest, type Request } from 'firebase-functions/v2/https';
import cors from 'cors';
import express from 'express';
import type { Response } from 'express';
import { failedRequest } from './log';

const corsHandler = cors({ origin: true });

export type Handler = (req: Request, res: Response) => Promise<void>;

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
        res.status(failedRequest(req, err)).send({ ok: false, error: (err as Error).message });
      }
    });
  });
}

/**
 * A handler for a route of the `numbers` app: Meta or validation errors become a JSON answer. (CORS and the
 * method are the app's business.)
 */
export function handle(handler: Handler) {
  return async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      await handler(req as unknown as Request, res);
    } catch (err) {
      res.status(failedRequest(req, err)).send({ ok: false, error: (err as Error).message });
    }
  };
}

/** An Express app for one function: CORS for the dashboard, and JSON bodies. */
export function newApp(): express.Express {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json());
  return app;
}

const BEARER_KEY = /^Bearer ([0-9a-f]{64})$/;

/**
 * A route about a number, `/<function>/<phone number ID>/...`. The handlers read their input from the request
 * body, so this copies the number ID from the path, and the Watobot API key from the bearer token, into it.
 * With `keyRequired` false the route also takes the dashboard's sign-in token (the handler then asks for it).
 */
export function numberRoute(handler: Handler, options: { keyRequired: boolean }): express.RequestHandler {
  const run = handle(handler);
  return (req, res) => {
    const key = BEARER_KEY.exec(req.headers.authorization ?? '')?.[1];
    if (!key && options.keyRequired) {
      res.status(401).send({ ok: false, error: 'Missing Authorization: Bearer <your Watobot API key>' });
      return;
    }
    req.body = { ...(req.body ?? {}), phoneNumberId: req.params.phoneNumberId, ...(key ? { apiKey: key } : {}) };
    return run(req, res);
  };
}
