import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/** True for addresses that must never be fetched on a customer's say-so: this machine, private networks, link-local (including cloud metadata). */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

/**
 * Refuses URLs that would make our server call something it shouldn't: not HTTPS, a private or
 * internal address, or a name that resolves to one. The signed-in user supplies the URL, so this
 * is what keeps "test my endpoint" from being a way to probe our network.
 */
export async function checkPublicUrl(url: string): Promise<CheckResult> {
  // The integration tests use a local http stub as the customer's endpoint.
  if (process.env.ALLOW_HTTP_ENDPOINT === 'true') return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Endpoint must be HTTPS — Meta requires it for webhooks.' };
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'That address is not reachable from the internet.' };
  }
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, error: 'That address is not reachable from the internet.' };
    }
  } catch {
    return { ok: false, error: `Could not find ${host}.` };
  }
  return { ok: true };
}

/**
 * Hits the business's own endpoint with the exact same GET verification
 * handshake Meta itself performs (hub.mode/hub.verify_token/hub.challenge)
 * before we ever call subscribed_apps with it as the override. Catches a
 * broken/misconfigured endpoint before it becomes Meta's problem.
 *
 * Pulled out of the onRequest handler so it's directly unit-testable without
 * needing to invoke the wrapped Cloud Function object.
 */
export async function verifyEndpointChallenge(url: string | undefined, verifyToken: string): Promise<CheckResult> {
  if (!url) return { ok: false, error: 'url is required' };
  // ALLOW_HTTP_ENDPOINT is set only by the integration test runner, so tests can
  // use a local http stub as the "business endpoint". Never set in production.
  const publicCheck = await checkPublicUrl(url);
  if (!publicCheck.ok) return publicCheck;

  const challenge = Math.random().toString(36).slice(2);
  const verifyUrl = new URL(url);
  verifyUrl.searchParams.set('hub.mode', 'subscribe');
  verifyUrl.searchParams.set('hub.verify_token', verifyToken);
  verifyUrl.searchParams.set('hub.challenge', challenge);

  try {
    const fetchRes = await fetch(verifyUrl, { signal: AbortSignal.timeout(8000) });
    const text = (await fetchRes.text()).trim();
    if (fetchRes.status === 200 && text === challenge) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Endpoint responded ${fetchRes.status} with body "${text.slice(0, 200)}" — expected 200 echoing back the challenge string unchanged.`,
    };
  } catch (err) {
    return { ok: false, error: `Could not reach endpoint: ${(err as Error).message}` };
  }
}
