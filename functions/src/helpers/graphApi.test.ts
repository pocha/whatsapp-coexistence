import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeCodeForToken, subscribeApp, verifyWabaAccess } from './graphApi';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test('exchangeCodeForToken sends the right request and returns the access token', async () => {
  let requestedUrl: string | undefined;
  global.fetch = (async (url: string | URL) => {
    requestedUrl = url.toString();
    return new Response(JSON.stringify({ access_token: 'fake-token-123' }), { status: 200 });
  }) as typeof fetch;

  const token = await exchangeCodeForToken('the-code', 'app-id', 'app-secret');

  assert.equal(token, 'fake-token-123');
  assert.ok(requestedUrl?.includes('/oauth/access_token'));
  assert.ok(requestedUrl?.includes('client_id=app-id'));
  assert.ok(requestedUrl?.includes('client_secret=app-secret'));
  assert.ok(requestedUrl?.includes('code=the-code'));
});

test('subscribeApp posts the override callback and verify token to the right WABA', async () => {
  let requestedUrl: string | undefined;
  let requestedInit: RequestInit | undefined;
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    requestedUrl = url.toString();
    requestedInit = init;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  await subscribeApp('waba-123', 'access-token-abc', 'https://business.example.com/webhook', 'verify-me');

  assert.ok(requestedUrl?.includes('/waba-123/subscribed_apps'));
  assert.equal(requestedInit?.method, 'POST');
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, 'Bearer access-token-abc');

  const body = JSON.parse(requestedInit?.body as string);
  assert.equal(body.override_callback_uri, 'https://business.example.com/webhook');
  assert.equal(body.verify_token, 'verify-me');
});

test('verifyWabaAccess reads the WABA with the bearer token and throws when Meta refuses', async () => {
  let requestedUrl: string | undefined;
  let auth: string | undefined;
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    requestedUrl = url.toString();
    auth = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ id: 'waba-123' }), { status: 200 });
  }) as typeof fetch;

  await verifyWabaAccess('waba-123', 'tok');
  assert.ok(requestedUrl?.includes('/waba-123?fields=id'));
  assert.equal(auth, 'Bearer tok');

  global.fetch = (async () => new Response(JSON.stringify({ error: 'bad' }), { status: 401 })) as typeof fetch;
  await assert.rejects(verifyWabaAccess('waba-123', 'bad'), /Graph API error \(401\)/);
});
