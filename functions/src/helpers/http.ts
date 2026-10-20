import cors from 'cors';
import express from 'express';
import type { Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/v2';
import { type Request, onRequest } from 'firebase-functions/v2/https';

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


export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Verifies the Firebase ID token on the Authorization header, returns the uid. */
export async function requireAuth(req: Request): Promise<string> {
  const authHeader = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) throw new HttpError(401, 'Missing Authorization: Bearer <firebase-id-token>');

  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch {
    throw new HttpError(401, 'Invalid or expired Firebase ID token');
  }
}


// Logs are readable by anyone with access to the project and are kept, so they hold IDs and
// outcomes only: never an API key, a Meta token, an OTP code, a message body or a full phone number.

/** The function this runs in, e.g. "registerNumber" (set by the Functions runtime). */
function functionName(): string {
  return process.env.FUNCTION_TARGET ?? process.env.K_SERVICE ?? 'unknown';
}

/** "+15553393615" -> "***3615". */
export function maskPhone(phone: unknown): string | undefined {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : undefined;
}

/** A line worth keeping for a state change, e.g. logEvent('registered', { phoneNumberId }). */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  logger.info(event, { fn: functionName(), ...fields });
}

/**
 * Logs a failed request and returns the status to answer with: an HttpError keeps its own,
 * anything else (Meta unreachable, a bug) is a 502. Client mistakes (4xx) are warnings and the
 * rest errors, so alerts can be set on severity.
 */
export function failedRequest(req: Pick<Request, 'path' | 'body' | 'params'>, err: unknown): number {
  const status = err instanceof HttpError ? err.status : 502;
  const fields = {
    fn: functionName(),
    status,
    path: req.path,
    phoneNumberId: req.params?.phoneNumberId ?? req.body?.phoneNumberId,
    error: (err as Error).message,
  };
  if (status >= 500) logger.error('request failed', { ...fields, stack: (err as Error).stack });
  else logger.warn('request rejected', fields);
  return status;
}
