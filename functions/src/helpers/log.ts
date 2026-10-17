import { logger } from 'firebase-functions/v2';
import type { Request } from 'firebase-functions/v2/https';
import { HttpError } from './auth';

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
