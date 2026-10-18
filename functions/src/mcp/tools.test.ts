import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { keyFromValue, UserError, type Context } from './api';
import { createServer } from './tools';

const KEY = '0123456789abcdef'.repeat(4);
const seen: { method?: string; url?: string; auth?: string; body?: any }[] = [];
let fake: http.Server;
let apiBase = '';

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/getNumber') {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'Unknown phone number ID.' }));
      } else {
        res.end(JSON.stringify({ ok: true, numbers: [] }));
      }
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
after(() => fake.close());

async function connect(key: () => string) {
  const ctx: Context = { key, apiBase, siteUrl: 'https://watobot.com' };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

test('a key that is missing or malformed is refused with what to do about it', () => {
  assert.throws(() => keyFromValue(undefined, 'https://watobot.com'), (e) => e instanceof UserError && /Sign up at https:\/\/watobot\.com/.test(e.message));
  assert.throws(() => keyFromValue('abc', 'https://watobot.com'), (e) => e instanceof UserError && /not a Watobot API key/.test(e.message));
  assert.equal(keyFromValue(` ${KEY}\n`, 'https://watobot.com'), KEY);
});

test('without a key every tool says how to get one, and nothing is sent', async () => {
  const client = await connect(() => keyFromValue(undefined, 'https://watobot.com'));
  const res: any = await client.callTool({ name: 'list_numbers', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Sign up at https:\/\/watobot\.com/);
  assert.equal(seen.length, 0);
});

test('the key goes to the functions (in the body, or as the bearer token) and never comes back in an answer', async () => {
  const client = await connect(() => KEY);

  const list: any = await client.callTool({ name: 'list_numbers', arguments: {} });
  assert.equal(list.isError, undefined);
  assert.equal(seen.at(-1)!.url, '/listNumbers');
  assert.equal(seen.at(-1)!.body.apiKey, KEY);
  assert.equal(JSON.stringify(list).includes(KEY), false);

  await client.callTool({ name: 'get_limits', arguments: { phoneNumberId: '1234567890' } });
  assert.equal(seen.at(-1)!.url, '/relayMessage/1234567890/limits');
  assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);

  const missing: any = await client.callTool({ name: 'get_number', arguments: { phoneNumberId: '1234567890' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Unknown phone number ID/);
  assert.equal(JSON.stringify(missing).includes(KEY), false);
});

test('the tools that cannot be undone say so, and the link skips the finished checks', async () => {
  const client = await connect(() => KEY);
  const { tools } = await client.listTools();
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(destructive, ['delete_template', 'deregister_number', 'disconnect_number', 'skip_sync']);

  const link: any = await client.callTool({ name: 'start_onboarding_link', arguments: { overrideCallbackUrl: 'https://example.com/hook' } });
  assert.match(link.content[0].text, /create\.html\?checks=done&callback=https%3A%2F%2Fexample\.com%2Fhook/);
});
