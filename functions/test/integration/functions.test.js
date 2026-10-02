const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'wa-coexistence';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;

// Whatever's actually configured in functions/.env — real or placeholder,
// this test shouldn't assume one or the other, just match what's there.
const envFile = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
const WEBHOOK_VERIFY_TOKEN = envFile.match(/^WEBHOOK_VERIFY_TOKEN=(.*)$/m)[1].trim();

let idToken;
let admin;
let db;

before(async () => {
  // Mint a real ID token against the Auth emulator's REST API.
  const signUp = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123', returnSecureToken: true }),
    },
  );
  const signUpBody = await signUp.json();
  assert.ok(signUpBody.idToken, `expected idToken in signUp response, got: ${JSON.stringify(signUpBody)}`);
  idToken = signUpBody.idToken;

  admin = require('firebase-admin');
  admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
});

test('webhook GET verify handshake echoes the challenge for a matching token', async () => {
  const url =
    `${FUNCTIONS_BASE}/webhook?hub.mode=subscribe&hub.verify_token=${WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc123`;
  const res = await fetch(url);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(text, 'abc123');
});

test('exchangeCode returns the access token to a signed-in caller', async () => {
  const res = await fetch(`${FUNCTIONS_BASE}/exchangeCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ code: 'fake-signup-code' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accessToken: 'stub-access-token' });
});

test('exchangeCode rejects a caller who is not signed in', async () => {
  const res = await fetch(`${FUNCTIONS_BASE}/exchangeCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake-signup-code' }),
  });
  assert.equal(res.status, 401);
});

const BUSINESS_ENDPOINT = 'http://127.0.0.1:9905/business-endpoint';

test('setWebhook verifies the token and the endpoint, then subscribes, with no sign-in', async () => {
  const res = await fetch(`${FUNCTIONS_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wabaId: 'waba-integration-test',
      accessToken: 'valid-user-token',
      overrideCallbackUrl: BUSINESS_ENDPOINT,
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('setWebhook refuses an access token Meta does not accept', async () => {
  const res = await fetch(`${FUNCTIONS_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wabaId: 'waba-integration-test',
      accessToken: 'some-other-token',
      overrideCallbackUrl: BUSINESS_ENDPOINT,
    }),
  });
  assert.equal(res.status, 401);
});

test('setWebhook refuses an endpoint that does not answer the handshake', async () => {
  const res = await fetch(`${FUNCTIONS_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wabaId: 'waba-integration-test',
      accessToken: 'valid-user-token',
      overrideCallbackUrl: 'http://127.0.0.1:9905/not-an-endpoint',
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('relayMessage proxies a send through the stub and records usage against the WABA doc', async () => {
  const phoneNumberId = 'phone-relay-test';
  const wabaId = 'waba-relay-test';
  const ownerUid = 'owner-for-relay-test';

  await db.collection('wabas').doc(wabaId).set({
    ownerUid,
    wabaId,
    phoneNumberId,
    overrideUrl: 'https://business.example.com/webhook',
  });

  const res = await fetch(`${FUNCTIONS_BASE}/relayMessage/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer any-whatsapp-token' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hello from the integration test' },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.messages[0].id, 'wamid.stub-message-id');

  const doc = await db.collection('wabas').doc(wabaId).get();
  const data = doc.data();
  assert.equal(data.lastRelayCall.ok, true);
  assert.equal(data.lastRelayCall.statusCode, 200);

  const today = new Date().toISOString().slice(0, 10);
  assert.equal(data.usage.daily[today], 1);
});
