// What the tools need to reach Watobot: where its functions are, where the site is, and the
// caller's API key. The local server (mcp/) reads these from its environment; the hosted one
// (hosted.ts) takes the key from each request. The key is only ever sent to the functions: never
// logged, never put in a tool's answer.

/** Something the person (or the AI tool) can act on, as opposed to a bug in this server. */
export class UserError extends Error {}

export interface Context {
  /** The caller's API key. Throws a UserError that says how to get one when there is none. */
  key: () => string;
  /** Where the functions are, e.g. https://us-central1-wa-coexistence.cloudfunctions.net */
  apiBase: string;
  /** The website, for sign-up and the onboarding link. */
  siteUrl: string;
}

export const DEFAULT_SITE = 'https://watobot.com';
export const DEFAULT_API = 'https://us-central1-wa-coexistence.cloudfunctions.net';

export function noKeyMessage(siteUrl: string): string {
  return (
    `There is no Watobot API key yet. Sign up at ${siteUrl} (sign in with your phone number and the code Watobot sends on WhatsApp), ` +
    `create your API key on the "API key" page (it is made in your browser and shown once, so copy it), ` +
    'then set it as WATOBOT_API_KEY in this MCP server\'s settings and restart it. ' +
    'No tool can create the key for you.'
  );
}

/** The key from an environment value, checked for shape. */
export function keyFromValue(value: string | undefined, siteUrl: string): string {
  const key = value?.trim();
  if (!key) throw new UserError(noKeyMessage(siteUrl));
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new UserError(`That is not a Watobot API key (it is 64 characters, 0-9 and a-f). Copy it again from the API key page on ${siteUrl}.`);
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

/** The two ways the functions take the key: in the body (the numbers, the wizard, the reads), or as the bearer token (the relay and templates). */
export function apiFor(ctx: Context) {
  return {
    callFunction: (name: string, body: Record<string, unknown> = {}) =>
      send(`${ctx.apiBase}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, apiKey: ctx.key() }),
      }),
    callWithBearer: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
      send(`${ctx.apiBase}/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.key()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}
