import { config } from './config';

// Overridable so tests can point this at a local stub instead of the real
// Meta API for end-to-end happy-path coverage.
export function graphApiBase(): string {
  return process.env.GRAPH_API_BASE ?? `https://graph.facebook.com/${config.graphApiVersion}`;
}

async function graphFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${graphApiBase()}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Graph API error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Exchanges the Embedded Signup `code` for a WABA-scoped access token. */
export async function exchangeCodeForToken(code: string, appId: string, appSecret: string): Promise<string> {
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  const body = await graphFetch(`/oauth/access_token?${params.toString()}`, { method: 'GET' });
  return body.access_token as string;
}

/**
 * Subscribes this app to the business's WABA events, with Meta delivering
 * them straight to `overrideCallbackUrl` instead of this app's own webhook —
 * the "onboard, then get out of the message path" step.
 */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
  overrideCallbackUrl: string,
  verifyToken: string,
): Promise<void> {
  await graphFetch(`/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      override_callback_uri: overrideCallbackUrl,
      verify_token: verifyToken,
    }),
  });
}
