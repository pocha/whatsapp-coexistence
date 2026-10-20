import { randomInt } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { TestEventType } from './types';

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


// Test webhooks the "Send test data" button posts to a customer's callback URL, shaped like the
// real ones Meta sends, so the customer can check their endpoint parses and stores each kind
// before the one-time contacts and history sync runs. Each carries a short code in the text a real
// event would carry (message body, contact name...), which the customer reads back from wherever
// they saved it.

export const TEST_EVENT_TYPES: TestEventType[] = ['message', 'echo', 'contacts', 'history'];

// No 0/O or 1/I/L, so a code read off a screen or a database is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCode(): string {
  let code = 'WB-';
  for (let i = 0; i < 5; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function newCodes(): Record<TestEventType, string> {
  return { message: newCode(), echo: newCode(), contacts: newCode(), history: newCode() };
}

const BUSINESS = '15550001111';
const CUSTOMER = '15550002222';
const metadata = { display_phone_number: BUSINESS, phone_number_id: 'TEST_PHONE_NUMBER_ID' };

function envelope(field: string, value: object): object {
  return { object: 'whatsapp_business_account', entry: [{ id: 'TEST_MESSAGING_ACCOUNT_ID', time: Math.floor(Date.now() / 1000), changes: [{ field, value }] }] };
}

/** The webhook body for one kind of test event. */
export function buildTestEvent(type: TestEventType, code: string): object {
  const timestamp = String(Math.floor(Date.now() / 1000));
  switch (type) {
    case 'message':
      return envelope('messages', {
        messaging_product: 'whatsapp',
        metadata,
        contacts: [{ profile: { name: 'Watobot Test' }, wa_id: CUSTOMER }],
        messages: [{ from: CUSTOMER, id: `wamid.TEST${code}`, timestamp, type: 'text', text: { body: `Watobot test message ${code}` } }],
      });
    case 'echo':
      return envelope('smb_message_echoes', {
        messaging_product: 'whatsapp',
        metadata,
        message_echoes: [{ from: BUSINESS, to: CUSTOMER, id: `wamid.TEST${code}`, timestamp, type: 'text', text: { body: `Watobot test echo ${code}` } }],
      });
    case 'contacts':
      return envelope('smb_app_state_sync', {
        messaging_product: 'whatsapp',
        metadata,
        state_sync: [{ type: 'contact', contact: { full_name: `Watobot Test ${code}`, first_name: 'Watobot', phone_number: CUSTOMER }, action: 'add', metadata: { timestamp } }],
      });
    case 'history':
      return envelope('history', {
        messaging_product: 'whatsapp',
        metadata,
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 100 },
            threads: [
              {
                id: CUSTOMER,
                messages: [
                  { from: CUSTOMER, id: `wamid.TEST${code}`, timestamp, type: 'text', text: { body: `Watobot test history ${code}` }, history_context: { status: 'READ' } },
                ],
              },
            ],
          },
        ],
      });
  }
}

export interface SendResult {
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

/** Posts one test event and reports what the endpoint answered. */
export async function sendTestEvent(url: string, type: TestEventType, code: string): Promise<SendResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Watobot-Test': 'true' },
      body: JSON.stringify(buildTestEvent(type, code)),
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    return { ok: res.ok, status: res.status, ms: Date.now() - started, error: res.ok ? undefined : `The endpoint answered ${res.status}.` };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: `Could not reach the endpoint: ${(err as Error).message}` };
  }
}
