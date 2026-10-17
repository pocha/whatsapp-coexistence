import { HttpError } from './helpers/auth';
import { requireCaller } from './accounts';
import { post } from './helpers/http';
import { listNumbersForUser, readNumber } from './helpers/model';
import { numberView, relayLimits } from './helpers/numberView';
import type { GetNumberResponse, ListNumbersResponse } from './helpers/types';

// Reads for the dashboard and the MCP: what numbers an account has and where each stands. They
// answer the caller about their own numbers only, and never carry the stored token (numberView).

export const listNumbers = post(async (req, res) => {
  const userId = await requireCaller(req);
  const body: ListNumbersResponse = { ok: true, numbers: (await listNumbersForUser(userId)).map(numberView) };
  res.status(200).send(body);
});

export const getNumber = post(async (req, res) => {
  const userId = await requireCaller(req);
  const phoneNumberId = String(req.body?.phoneNumberId ?? '');
  const doc = phoneNumberId ? await readNumber(phoneNumberId) : undefined;
  // The same answer for a number that doesn't exist and one that is someone else's.
  if (!doc || doc.userId !== userId) throw new HttpError(404, 'Unknown phone number ID.');
  const body: GetNumberResponse = { ok: true, number: numberView(doc), limits: relayLimits(doc, Date.now()) };
  res.status(200).send(body);
});
