import type { Request } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';

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
