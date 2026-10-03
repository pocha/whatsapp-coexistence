const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const PROJECT_ID = 'wa-coexistence';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;

const { hashApiKey, encryptToken, decryptToken } = require('../../lib/apiKey');

const KEY = '0123456789abcdef'.repeat(4);
const NEW_KEY = 'fedcba9876543210'.repeat(4);
const BUSINESS_ENDPOINT = 'http://127.0.0.1:9905/business-endpoint';
const META_TOKEN = 'stub-access-token';

let admin;
let db;
let idToken;
let userId;

const post = (path, body, headers = {}) =>
  fetch(`${FUNCTIONS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const asUser = () => ({ Authorization: `Bearer ${idToken}` });

async function seedNumber(phoneNumberId, wabaId, key = KEY) {
  await db.collection('phoneNumbers').doc(phoneNumberId).set({
    userId,
    wabaId,
    phoneNumberId,
    encAccessToken: encryptToken(META_TOKEN, key),
  });
}

before(async () => {
  // A signed-in user, via the Auth emulator's REST API.
  const signUp = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123', returnSecureToken: true }),
    },
  );
  const body = await signUp.json();
  assert.ok(body.idToken, `expected idToken, got: ${JSON.stringify(body)}`);
  idToken = body.idToken;
  userId = body.localId;

  admin = require('firebase-admin');
  admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
  await db.collection('users').doc(userId).set({ phoneNumber: '919000000001', apiKeyHash: hashApiKey(KEY), createdAt: 1 });
});

test('webhook GET verify handshake echoes the challenge for a matching token', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const verifyToken = env.match(/^WEBHOOK_VERIFY_TOKEN=(.*)$/m)[1].trim();
  const res = await fetch(`${FUNCTIONS_BASE}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=abc123`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'abc123');
});

test('exchangeCode stores the Meta token encrypted under the API key and never returns it', async () => {
  const res = await post(
    '/exchangeCode',
    { code: 'fake-signup-code', wabaId: '111', phoneNumberId: '222', apiKey: KEY },
    asUser(),
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(body).includes(META_TOKEN), false, 'the token must not be in the response');

  const stored = (await db.collection('phoneNumbers').doc('222').get()).data();
  assert.equal(stored.userId, userId);
  assert.equal(stored.wabaId, '111');
  assert.equal(JSON.stringify(stored).includes(META_TOKEN), false, 'the token must not be stored in the clear');
  assert.equal(decryptToken(stored.encAccessToken, KEY), META_TOKEN);
  assert.throws(() => decryptToken(stored.encAccessToken, NEW_KEY));
});

test('exchangeCode refuses a wrong API key and an unauthenticated caller', async () => {
  const body = { code: 'c', wabaId: '111', phoneNumberId: '223', apiKey: NEW_KEY };
  assert.equal((await post('/exchangeCode', body, asUser())).status, 401);
  assert.equal((await post('/exchangeCode', { ...body, apiKey: KEY })).status, 401);
  assert.equal((await db.collection('phoneNumbers').doc('223').get()).exists, false);
});

test('rotateKey re-encrypts the tokens under the new key and replaces the hash', async () => {
  await seedNumber('555', '666');
  assert.equal((await post('/rotateKey', { oldApiKey: NEW_KEY, newApiKey: KEY }, asUser())).status, 401);

  const res = await post('/rotateKey', { oldApiKey: KEY, newApiKey: NEW_KEY }, asUser());
  assert.equal(res.status, 200);
  const stored = (await db.collection('phoneNumbers').doc('555').get()).data();
  assert.equal(decryptToken(stored.encAccessToken, NEW_KEY), META_TOKEN);
  assert.throws(() => decryptToken(stored.encAccessToken, KEY));
  assert.equal((await db.collection('users').doc(userId).get()).data().apiKeyHash, hashApiKey(NEW_KEY));

  // Put the original key back so the tests below still use KEY.
  assert.equal((await post('/rotateKey', { oldApiKey: NEW_KEY, newApiKey: KEY }, asUser())).status, 200);
});

test('setWebhook needs the API key, then verifies the endpoint and subscribes, with no sign-in', async () => {
  await seedNumber('333', '444');
  const ok = await post('/setWebhook', { phoneNumberId: '333', apiKey: KEY, overrideCallbackUrl: BUSINESS_ENDPOINT });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  const saved = (await db.collection('phoneNumbers').doc('333').get()).data();
  assert.equal(saved.overrideUrl, BUSINESS_ENDPOINT, 'the function records the URL itself');

  const wrongKey = await post('/setWebhook', { phoneNumberId: '333', apiKey: NEW_KEY, overrideCallbackUrl: BUSINESS_ENDPOINT });
  assert.equal(wrongKey.status, 401);

  const badEndpoint = await post('/setWebhook', {
    phoneNumberId: '333',
    apiKey: KEY,
    overrideCallbackUrl: 'http://127.0.0.1:9905/not-an-endpoint',
  });
  assert.equal(badEndpoint.status, 400);
});

test('relayMessage authenticates with the API key, sends with the decrypted Meta token, and records usage', async () => {
  await seedNumber('555', '666');
  const send = (key) =>
    fetch(`${FUNCTIONS_BASE}/relayMessage/555/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567', type: 'text', text: { body: 'hi' } }),
    });

  const res = await send(KEY);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).messages[0].id, 'wamid.stub-message-id');
  assert.equal((await send(NEW_KEY)).status, 401);

  const data = (await db.collection('phoneNumbers').doc('555').get()).data();
  assert.equal(data.lastRelayCall.ok, true);
  assert.equal(data.usage.daily[new Date().toISOString().slice(0, 10)], 1);
});

test('templates lists, creates and deletes through the stored token', async () => {
  await seedNumber('777', '888');
  const call = (method, query = '', body) =>
    fetch(`${FUNCTIONS_BASE}/templates/777${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: body ? JSON.stringify(body) : undefined,
    });

  const list = await call('GET');
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].name, 'stub_template');
  assert.equal((await call('POST', '', { name: 'x', category: 'UTILITY', language: 'en_US', components: [] })).status, 200);
  assert.equal((await call('DELETE', '?name=x')).status, 200);

  const wrong = await fetch(`${FUNCTIONS_BASE}/templates/777`, { headers: { Authorization: `Bearer ${NEW_KEY}` } });
  assert.equal(wrong.status, 401);
});

test('login: a new phone number gets a user, sets a key, and then needs that key to log in', async () => {
  const phone = '919000000099';
  const otp = async () => db.collection('otps').doc(phone).set({ code: '123456', expiresAt: Date.now() + 60_000, attempts: 0, lastSentAt: 0 });

  await otp();
  const first = await (await post('/verifyOtp', { phone, code: '123456' })).json();
  assert.equal(first.ok, true);
  const index = (await db.collection('phoneIndex').doc(phone).get()).data();
  assert.ok(index.userId, 'a user is created with a random id');
  assert.equal((await db.collection('users').doc(index.userId).get()).data().phoneNumber, phone);

  // The custom token signs in as that user, who can then set their key.
  const signIn = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: first.token, returnSecureToken: true }) },
  );
  const { idToken: newUserToken } = await signIn.json();
  const signedInAs = JSON.parse(Buffer.from(newUserToken.split('.')[1], 'base64url').toString()).user_id;
  assert.equal(signedInAs, index.userId, 'the Firebase uid is the random user id, not the phone number');
  assert.ok(newUserToken, 'the custom token signs in');
  // The user sets their own key from the browser (rules permit it); simulate that write.
  await db.collection('users').doc(index.userId).update({ apiKeyHash: hashApiKey(KEY) });

  // Next login: right code alone is not enough.
  await otp();
  const needsKey = await (await post('/verifyOtp', { phone, code: '123456' })).json();
  assert.equal(needsKey.ok, false);
  assert.equal(needsKey.needsApiKey, true);
  const withKey = await (await post('/verifyOtp', { phone, code: '123456', apiKey: KEY })).json();
  assert.equal(withKey.ok, true);
});
