import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { graphApiBase } from './graphApi';
import { authenticateKey } from './accounts';
import { HttpError } from './auth';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Message template list / create / edit / delete for a number's WABA, using the stored
// Meta token. Same auth as the relay: `Authorization: Bearer <Watobot API key>`.
// Meta's response and status are returned unchanged.
async function forward(
  req: express.Request,
  res: express.Response,
  method: 'GET' | 'POST' | 'DELETE',
  query: string,
  body?: unknown,
  templateId?: string,
) {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    const { wabaId, accessToken } = await authenticateKey(req.params.phoneNumberId, key);
    // Editing posts to the template's own id; everything else works on the WABA's collection.
    const target = templateId ?? `${wabaId}/message_templates`;
    const metaRes = await fetch(`${graphApiBase()}/${target}${query}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    res.status(metaRes.status).send(await metaRes.json().catch(() => ({})));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).send({ error: (err as Error).message });
  }
}

app.get('/:phoneNumberId', (req, res) =>
  forward(req, res, 'GET', '?fields=id,name,status,category,language,components&limit=100'),
);
app.post('/:phoneNumberId', (req, res) => forward(req, res, 'POST', '', req.body));
app.post('/:phoneNumberId/:templateId', (req, res) => {
  if (!/^\d+$/.test(req.params.templateId)) {
    res.status(400).send({ error: 'The template id is the number from the list response.' });
    return;
  }
  forward(req, res, 'POST', '', req.body, req.params.templateId);
});
app.delete('/:phoneNumberId', (req, res) =>
  forward(req, res, 'DELETE', `?name=${encodeURIComponent(String(req.query.name ?? ''))}`),
);

export const templates = onRequest(app);
