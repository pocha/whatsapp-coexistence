// The calls to Watobot's functions. The API key comes from the environment of whoever launched this
// server and is only ever sent to the functions: never logged, never put in a tool's answer.

/** Something the person (or the AI tool) can act on, as opposed to a bug in this server. */
export class UserError extends Error {}

export const SITE = (process.env.WATOBOT_SITE_URL ?? 'https://watobot.com').replace(/\/$/, '');
const BASE = (process.env.WATOBOT_API_URL ?? 'https://us-central1-wa-coexistence.cloudfunctions.net').replace(/\/$/, '');

const NO_KEY =
  `There is no Watobot API key yet. Sign up at ${SITE} (sign in with your phone number and the code Watobot sends on WhatsApp), ` +
  `create your API key on the "API key" page (it is made in your browser and shown once, so copy it), ` +
  'then set it as WATOBOT_API_KEY in this MCP server\'s settings and restart it. ' +
  'No tool can create the key for you.';

export function apiKey(): string {
  const key = process.env.WATOBOT_API_KEY?.trim();
  if (!key) throw new UserError(NO_KEY);
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new UserError('WATOBOT_API_KEY is not a Watobot API key (it is 64 characters, 0-9 and a-f). Copy it again from the API key page on ' + SITE + '.');
  }
  return key;
}

async function send(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(300_000) });
  } catch (err) {
    throw new UserError(`Could not reach Watobot (${(err as Error).message}).`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok || data?.ok === false) {
    const retry = res.headers.get('retry-after');
    const why = typeof data?.error === 'string' ? data.error : data?.error ? JSON.stringify(data.error) : `HTTP ${res.status}`;
    throw new UserError(`${why} (HTTP ${res.status}${retry ? `, try again in ${retry}s` : ''})`);
  }
  return data;
}

/** A function that takes the key in the body (the numbers, the wizard, the account reads). */
export function callFunction(name: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return send(`${BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, apiKey: apiKey() }),
  });
}

/** The relay and templates, which take the key as the bearer token. */
export function callWithBearer(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  return send(`${BASE}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
