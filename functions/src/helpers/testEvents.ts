import { randomInt } from 'node:crypto';
import type { TestEventType } from './types';

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
