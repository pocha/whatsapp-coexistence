const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const PROJECT_ID = 'wa-coexistence';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`;

const { hashApiKey, encryptToken, decryptToken } = require('../../lib/helpers/apiKey');

const KEY = '0123456789abcdef'.repeat(4);
const NEW_KEY = 'fedcba9876543210'.repeat(4);
const BUSINESS_ENDPOINT = 'http://127.0.0.1:9905/business-endpoint';
const META_TOKEN = 'stub-access-token';

let admin;
let db;
let idToken;
let userId;

// Calls to the Functions. The calls about a number go to the `numbers` API (see numbersApi.ts), where the
// number ID is in the path and the key is the bearer token; the tests below keep naming them by what they
// do, and this maps each name onto its route.
const NUMBER_ROUTES = {
  listNumbers: ['GET', () => '/numbers'],
  getNumber: ['GET', (id) => `/numbers/${id}`],
  setWebhook: ['PUT', (id) => `/numbers/${id}/webhook`],
  setDisplayName: ['PUT', (id) => `/numbers/${id}/display-name`],
  registerNumber: ['POST', (id) => `/numbers/${id}/register`],
  deregisterNumber: ['POST', (id) => `/numbers/${id}/deregister`],
  disconnectNumber: ['POST', (id) => `/numbers/${id}/disconnect`],
  startSync: ['POST', (id) => `/onboarding/${id}/sync`],
  skipSync: ['POST', (id) => `/onboarding/${id}/sync/skip`],
  setOnboardingStep: ['PUT', (id) => `/onboarding/${id}/step`],
};
// Calls that come before there is a number: the body is unchanged, only the path differs.
const PLAIN_ROUTES = {
  exchangeCode: '/numbers',
  checkCallbackUrl: '/onboarding/callback-check',
  sendTestEvents: '/onboarding/test-events',
  verifyTestCodes: '/onboarding/test-codes',
};

const post = (path, body, headers = {}) => {
  const route = NUMBER_ROUTES[path.slice(1)];
  if (!route) {
    return fetch(`${FUNCTIONS_BASE}${PLAIN_ROUTES[path.slice(1)] ?? path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }
  const { phoneNumberId, apiKey, refresh, ...rest } = body ?? {};
  const [method, urlFor] = route;
  return fetch(`${FUNCTIONS_BASE}${urlFor(phoneNumberId)}${refresh ? '?refresh=true' : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(rest),
  });
};

const asUser = () => ({ Authorization: `Bearer ${idToken}` });
const FieldValueDelete = () => require('firebase-admin').firestore.FieldValue.delete();

async function seedNumber(phoneNumberId, wabaId, key = KEY) {
  await db.collection('phoneNumbers').doc(phoneNumberId).set({
    userId,
    wabaId,
    phoneNumberId,
    encAccessToken: encryptToken(META_TOKEN, key),
    onboarding: { step: 'done', event: 'FINISH', updatedAt: 1 },
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
    { code: 'c:111', wabaId: '111', phoneNumberId: '222', apiKey: KEY, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' },
    asUser(),
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.step, 'override', 'a new number starts the wizard at the override step');
  assert.equal(JSON.stringify(body).includes(META_TOKEN), false, 'the token must not be in the response');

  const stored = (await db.collection('phoneNumbers').doc('222').get()).data();
  assert.equal(stored.userId, userId);
  assert.equal(stored.wabaId, '111');
  assert.equal(JSON.stringify(stored).includes(META_TOKEN), false, 'the token must not be stored in the clear');
  assert.equal(decryptToken(stored.encAccessToken, KEY), META_TOKEN);
  assert.throws(() => decryptToken(stored.encAccessToken, NEW_KEY));
});

test('exchangeCode refuses a wrong API key and an unauthenticated caller', async () => {
  const body = { code: 'c:111', wabaId: '111', phoneNumberId: '222', apiKey: NEW_KEY, event: 'FINISH' };
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

test('the relay authenticates with the API key, sends with the decrypted Meta token, and records usage', async () => {
  await seedNumber('555', '666');
  const send = (key) =>
    fetch(`${FUNCTIONS_BASE}/numbers/555/messages`, {
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

test('template sends are rate limited per number, and free-form text is not', async () => {
  await seedNumber('556', '667');
  // A ceiling from the number's health, so the test needs only a few sends: the day allows 2.
  await db.collection('phoneNumbers').doc('556').update({ health: { phone: { quality: { send: 'limit', title: 't', message: 'm', at: 1, cap: { day: 2 } } } } });
  const send = (message) =>
    fetch(`${FUNCTIONS_BASE}/numbers/556/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567', ...message }),
    });
  const template = { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };

  const limits = (key = KEY) =>
    fetch(`${FUNCTIONS_BASE}/numbers/556/limits`, { headers: { Authorization: `Bearer ${key}` } });

  // Before anything is sent, the whole allowance is there.
  const start = await (await limits()).json();
  assert.equal(start.appliesTo, 'template messages');
  assert.deepEqual([start.windows.day.accepted, start.windows.day.limit, start.windows.day.remaining], [0, 2, 2]);
  assert.equal((await limits(NEW_KEY)).status, 401, 'the limits need the API key too');

  // Each send says what is left, so a sender can pace itself without asking.
  const first = await send(template);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-ratelimit-remaining-day'), '1');
  const second = await send(template);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-ratelimit-remaining-day'), '0');
  assert.ok(Number(second.headers.get('x-ratelimit-reset-day')) > Date.now() / 1000, 'the reset time is in the future');

  const refused = await send(template);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('x-ratelimit-remaining-day'), '0');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1, 'tells the caller when to retry');

  // After two sent and one refused: two went through, three were tried, none left.
  const after = (await (await limits()).json()).windows.day;
  assert.deepEqual([after.accepted, after.attempted, after.remaining], [2, 3, 0]);
  assert.ok(after.resetsInSeconds >= 1);

  assert.equal((await send({ type: 'text', text: { body: 'hi' } })).status, 200, 'free-form text is not limited');
  const state = (await db.collection('phoneNumbers').doc('556').get()).data().rateState;
  assert.equal(state.minute.current + state.minute.previous >= 2, true);
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

// ---- the onboarding wizard ----

const META_STUB = 'http://127.0.0.1:9905';
const metaCalls = async () => (await fetch(`${META_STUB}/__calls`)).json();
const numberDoc = async (id) => (await db.collection('phoneNumbers').doc(id).get()).data();

async function onboard(phoneNumberId, event) {
  const exchanged = await post(
    '/exchangeCode',
    { code: `c:9${phoneNumberId}`, wabaId: `9${phoneNumberId}`, phoneNumberId, apiKey: KEY, event },
    asUser(),
  );
  assert.equal(exchanged.status, 200, JSON.stringify(await exchanged.clone().json()));
  const webhook = await post('/setWebhook', { phoneNumberId, apiKey: KEY, overrideCallbackUrl: BUSINESS_ENDPOINT });
  return { status: webhook.status, body: await webhook.json() };
}

test('a coexistence signup goes on to the sync step and is never registered; a plain number is asked what to do', async () => {
  const coexistence = await onboard('222', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING');
  assert.equal(coexistence.status, 200, JSON.stringify(coexistence.body));
  assert.equal(coexistence.body.step, 'sync');
  assert.equal((await numberDoc('222')).isOnBizApp, true);
  assert.equal((await numberDoc('222')).sync.contacts.state, 'none');
  assert.equal((await metaCalls()).some((c) => c.includes('/222/register')), false, 'a coexistence number is already registered');

  const plain = await onboard('224', 'FINISH');
  assert.equal(plain.body.step, 'not_on_app');
  assert.equal((await numberDoc('224')).isOnBizApp, false);
});

test('onboarding with no callback URL subscribes without an override, skips the syncs, and still counts as set up', async () => {
  const exchange = (id, event) => post('/exchangeCode', { code: `c:9${id}`, wabaId: `9${id}`, phoneNumberId: id, apiKey: KEY, event }, asUser());

  assert.equal((await exchange('2280', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')).status, 200);
  const none = await post('/setWebhook', { phoneNumberId: '2280', apiKey: KEY, noCallback: true });
  const body = await none.json();
  assert.equal(none.status, 200, JSON.stringify(body));
  assert.equal(body.step, 'templates', 'there is nowhere to send the syncs, so the sync step is passed');
  const saved = await numberDoc('2280');
  assert.equal(saved.callbackSkipped, true);
  assert.equal(saved.overrideUrl, undefined);
  assert.equal(saved.sync.contacts.state, 'skipped');
  assert.equal(saved.sync.history.state, 'skipped');
  const one = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '2280' })).json();
  assert.equal(one.number.step, 'templates', 'not sent back to the callback step');
  assert.equal((await post('/setOnboardingStep', { phoneNumberId: '2280', apiKey: KEY, step: 'done' })).status, 200);

  assert.equal((await exchange('2281', 'FINISH')).status, 200);
  const apiOnly = await (await post('/setWebhook', { phoneNumberId: '2281', apiKey: KEY, noCallback: true })).json();
  assert.equal(apiOnly.step, 'not_on_app', 'an API-only number still chooses what to do');

  assert.equal((await post('/setWebhook', { phoneNumberId: '2281', apiKey: KEY })).status, 400, 'a URL or noCallback is needed');
});

test('skipping the sync marks both as skipped, moves on, and cannot be done twice', async () => {
  const done = await onboard('2283', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING');
  assert.equal(done.body.step, 'sync');
  const skipped = await post('/skipSync', { phoneNumberId: '2283', apiKey: KEY });
  assert.equal(skipped.status, 200);
  assert.equal((await skipped.json()).step, 'templates');
  const saved = await numberDoc('2283');
  assert.equal(saved.sync.contacts.state, 'skipped');
  assert.equal(saved.sync.history.state, 'skipped');
  assert.equal(saved.overrideUrl, BUSINESS_ENDPOINT, 'the URL is kept');
  assert.equal((await post('/skipSync', { phoneNumberId: '2283', apiKey: KEY })).status, 409);
  assert.equal((await post('/skipSync', { phoneNumberId: '2283', apiKey: NEW_KEY })).status, 401);
});

test('sign-up refuses IDs Meta does not back, and a number that belongs to another Watobot account', async () => {
  const exchange = (code, wabaId, phoneNumberId) => post('/exchangeCode', { code, wabaId, phoneNumberId, apiKey: KEY, event: 'FINISH' }, asUser());

  // The token was granted WABA 9990, but the browser says another one.
  const wrongWaba = await exchange('c:9990', '9991', '991');
  assert.equal(wrongWaba.status, 403);
  assert.equal((await db.collection('phoneNumbers').doc('991').get()).exists, false, 'nothing is stored');

  // The token covers WABA 9990, which does not list the number the browser names.
  const wrongNumber = await exchange('c:9990', '9990', '222');
  assert.equal(wrongNumber.status, 403);

  // A number that is on another Watobot account is not replaced, even with a real grant for it.
  await db.collection('phoneNumbers').doc('992').set({ userId: 'someone-else', wabaId: '9992', phoneNumberId: '992', onboarding: { step: 'done', event: 'FINISH', updatedAt: 1 } });
  const taken = await exchange('c:9992', '9992', '992');
  assert.equal(taken.status, 409);
  assert.equal((await db.collection('phoneNumbers').doc('992').get()).data().userId, 'someone-else', 'the owner is unchanged');

  // When Meta's list of a WABA's numbers can't be read, the token reading the number is enough.
  const fallback = await exchange('c:9777', '9777', '777');
  assert.equal(fallback.status, 200, JSON.stringify(await fallback.json()));
  assert.equal((await db.collection('phoneNumbers').doc('777').get()).data().userId, userId);
});

test('register refuses a number on the Business app, moves a plain number on, and keeps the step when Meta refuses', async () => {
  const register = (id) => post('/registerNumber', { phoneNumberId: id, apiKey: KEY, pin: '123456' });

  // 222 is on the Business app (see the test above).
  assert.equal((await register('222')).status, 409);
  assert.equal((await metaCalls()).some((c) => c.includes('/222/register')), false);

  await db.collection('phoneNumbers').doc('224').update({ 'onboarding.step': 'register' });
  const ok = await register('224');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).step, 'templates');

  // Registering straight from the "not on the app" choice screen moves on as well.
  await seedNumber('238', '9238');
  await db.collection('phoneNumbers').doc('238').update({ onboarding: { step: 'not_on_app', event: 'FINISH', updatedAt: 1 } });
  assert.equal((await (await register('238')).json()).step, 'templates');
  assert.equal((await numberDoc('238')).onboarding.step, 'templates');

  await seedNumber('229', '9229');
  await db.collection('phoneNumbers').doc('229').update({ onboarding: { step: 'register', event: 'FINISH', updatedAt: 1 } });
  const refused = await register('229');
  assert.equal(refused.status, 502);
  const kept = await numberDoc('229');
  assert.equal(kept.onboarding.step, 'register', 'the user can try again');
  assert.match(kept.onboarding.error, /wrong PIN/);
});

test('each sync can be requested once: contacts first, no repeat after it was accepted, a failed one can be tried again', async () => {
  const sync = (id, syncType) => post('/startSync', { phoneNumberId: id, apiKey: KEY, syncType });

  assert.equal((await sync('222', 'history')).status, 409, 'contacts come first');
  assert.equal((await sync('222', 'contacts')).status, 200);
  assert.equal((await sync('222', 'contacts')).status, 409, 'Meta allows it only once');
  assert.equal((await sync('222', 'history')).status, 200);
  assert.equal((await numberDoc('222')).sync.history.state, 'requested');

  await seedNumber('230', '9230');
  await db
    .collection('phoneNumbers')
    .doc('230')
    .update({ onboarding: { step: 'sync', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', updatedAt: 1 }, sync: { contacts: { state: 'none' }, history: { state: 'none' } } });
  assert.equal((await sync('230', 'contacts')).status, 502);
  assert.equal((await numberDoc('230')).sync.contacts.state, 'failed');
  assert.equal((await sync('230', 'contacts')).status, 502, 'a failed request is tried again, not refused as a repeat');
});

test('templates: a source we cannot read sends the user to their provider; a readable one is copied', async () => {
  const migrate = (sourceWabaId) =>
    fetch(`${FUNCTIONS_BASE}/templatesBulk/222/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ sourceWabaId }),
    });

  const before = (await metaCalls()).length;
  const unreadable = await (await migrate('99999999')).json();
  assert.equal(unreadable.outcome, 'unreadable');
  assert.equal((await metaCalls()).slice(before).some((c) => c.includes('migrate_message_templates')), false);

  const done = await (await migrate('123456789')).json();
  assert.equal(done.outcome, 'done');
  assert.equal(done.migrated, 3);
  assert.deepEqual(done.failed, [{ id: '4', reason: 'Incorrect category' }]);
});

// ---- reputation, and a number going back to the register step ----

test('the webhook takes only requests that Meta signed with the app secret', async () => {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const secret = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').match(/^META_APP_SECRET=(.*)$/m)[1].trim();
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'message_template_status_update', value: {} }] }] });
  const send = (signature) =>
    fetch(`${FUNCTIONS_BASE}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
      body,
    });
  assert.equal((await send(undefined)).status, 401);
  assert.equal((await send('sha256=' + crypto.createHmac('sha256', 'not-the-secret').update(body).digest('hex'))).status, 401);
  assert.equal((await send('sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex'))).status, 200);
});

test('disconnecting: an API-only number is unsubscribed and de-registered, a coexistence one only unsubscribed', async () => {
  await seedNumber('250', '9250');
  await db.collection('phoneNumbers').doc('250').update({ isOnBizApp: false });
  const plain = await (await post('/disconnectNumber', { phoneNumberId: '250', apiKey: KEY, deregister: true })).json();
  assert.deepEqual([plain.coexistence, plain.deregistered], [false, true]);

  // 222 is the number the stub reports as also on the WhatsApp Business app.
  const before = (await metaCalls()).length;
  const coexistence = await (await post('/disconnectNumber', { phoneNumberId: '222', apiKey: KEY, deregister: true })).json();
  assert.deepEqual([coexistence.coexistence, coexistence.deregistered], [true, false]);
  const calls = (await metaCalls()).slice(before);
  assert.equal(calls.some((c) => c.startsWith('DELETE') && c.includes('/9222/subscribed_apps')), true);
  assert.equal(calls.some((c) => c.includes('/222/deregister')), false, 'Meta cannot de-register a number on the Business app');
});

test('de-registering a plain number sends it to the register step', async () => {
  const { effectiveStep } = require('../../lib/helpers/onboarding');
  await db.collection('phoneNumbers').doc('241').set({
    userId,
    wabaId: '9241',
    phoneNumberId: '241',
    overrideUrl: BUSINESS_ENDPOINT,
    isOnBizApp: false,
    metaStatus: 'CONNECTED',
    encAccessToken: encryptToken(META_TOKEN, KEY),
    onboarding: { step: 'done', event: 'FINISH', updatedAt: 1 },
  });
  assert.equal(effectiveStep(await numberDoc('241')), 'done');

  const res = await post('/deregisterNumber', { phoneNumberId: '241', apiKey: KEY });
  assert.equal(res.status, 200);
  const after = await numberDoc('241');
  assert.equal(after.metaStatus, 'DEREGISTERED');
  assert.equal(effectiveStep(after), 'register');

  // Registering it again brings it back to done, with nothing else to do.
  const registered = await (await post('/registerNumber', { phoneNumberId: '241', apiKey: KEY, pin: '123456' })).json();
  assert.equal(registered.step, 'done');
});

test('the wizard checks take the API key as well as a sign-in, and refuse anything else', async () => {
  const withKey = await post('/checkCallbackUrl', { apiKey: KEY, overrideCallbackUrl: BUSINESS_ENDPOINT });
  assert.equal(withKey.status, 200);
  const withToken = await post('/checkCallbackUrl', { overrideCallbackUrl: BUSINESS_ENDPOINT }, asUser());
  assert.equal(withToken.status, 200, 'the dashboard still signs in');
  assert.equal((await post('/checkCallbackUrl', { apiKey: NEW_KEY, overrideCallbackUrl: BUSINESS_ENDPOINT })).status, 401, 'a key nobody has');
  assert.equal((await post('/checkCallbackUrl', { apiKey: 'nope', overrideCallbackUrl: BUSINESS_ENDPOINT })).status, 401, 'not even a key');
  assert.equal((await post('/checkCallbackUrl', { overrideCallbackUrl: BUSINESS_ENDPOINT })).status, 401, 'no credential at all');

  const events = await post('/sendTestEvents', { apiKey: KEY, overrideCallbackUrl: BUSINESS_ENDPOINT });
  assert.equal(events.status, 200, 'sending test events works with the key');
  const codes = await post('/verifyTestCodes', { apiKey: KEY, codes: {} });
  assert.equal(codes.status, 200, 'and so does checking the codes');
});

test('listNumbers and getNumber answer with the key or a sign-in, only for the caller\'s numbers, and never with the token', async () => {
  await seedNumber('9501', '9511');
  await db.collection('phoneNumbers').doc('9502').set({
    userId: 'someone-else',
    wabaId: '9512',
    phoneNumberId: '9502',
    encAccessToken: encryptToken(META_TOKEN, NEW_KEY),
    onboarding: { step: 'done', event: 'FINISH', updatedAt: 1 },
  });

  for (const credentials of [{ body: { apiKey: KEY }, headers: {} }, { body: {}, headers: asUser() }]) {
    const list = await post('/listNumbers', credentials.body, credentials.headers);
    assert.equal(list.status, 200);
    const text = JSON.stringify(await list.clone().json());
    assert.equal(text.includes('encAccessToken') || text.includes('ciphertext'), false, 'the token is never in the answer');
    const ids = (await list.json()).numbers.map((n) => n.phoneNumberId);
    assert.ok(ids.includes('9501'), 'their number is listed');
    assert.equal(ids.includes('9502'), false, 'someone else\'s is not');

    const one = await (await post('/getNumber', { ...credentials.body, phoneNumberId: '9501' }, credentials.headers)).json();
    assert.equal(one.number.hasToken, true);
    assert.equal(one.number.step, 'override', 'the step is worked out on the server (no callback URL is saved)');
    assert.equal(one.limits.windows.minute.limit > 0, true, 'the limits come with it');
  }

  assert.equal((await post('/getNumber', { apiKey: KEY, phoneNumberId: '9502' })).status, 404, 'someone else\'s number looks like it does not exist');
  assert.equal((await post('/listNumbers', { apiKey: NEW_KEY })).status, 401);
  assert.equal((await post('/listNumbers', {})).status, 401);
});

test('the hosted MCP server takes the key as a bearer token or in the path, refuses anything else, and its tools work', async () => {
  await seedNumber('9601', '9611');
  const rpc = (url, body, headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    });
  const asBearer = `${FUNCTIONS_BASE}/mcp`;
  const inPath = (key) => `${FUNCTIONS_BASE}/mcp/${key}`;
  const init = { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

  assert.equal((await rpc(asBearer, init)).status, 401, 'no key');
  assert.equal((await rpc(inPath(NEW_KEY), init)).status, 401, 'a key nobody has');
  assert.equal((await rpc(inPath('nope'), init)).status, 401, 'not a key');

  for (const [url, headers] of [[asBearer, { Authorization: `Bearer ${KEY}` }], [inPath(KEY), {}]]) {
    const hello = await (await rpc(url, init, headers)).json();
    assert.equal(hello.result.serverInfo.name, 'watobot');
    const tools = await (await rpc(url, { id: 2, method: 'tools/list' }, headers)).json();
    assert.ok(tools.result.tools.length >= 19);

    const list = await (await rpc(url, { id: 3, method: 'tools/call', params: { name: 'list_numbers', arguments: {} } }, headers)).json();
    assert.notEqual(list.result.isError, true, JSON.stringify(list));
    const text = list.result.content[0].text;
    assert.ok(JSON.parse(text).numbers.some((n) => n.phoneNumberId === '9601'), 'it lists the caller\'s numbers');
    assert.equal(text.includes(KEY) || text.includes('ciphertext'), false, 'neither the key nor a token comes back');
  }
  assert.equal((await fetch(inPath(KEY))).status, 405, 'only POST');
});

test('getNumber adds what Meta says right now when the key is given, part by part, and never the token', async () => {
  await seedNumber('9801', '9811');
  const withKey = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '9801', refresh: true })).json();
  assert.ok(withKey.meta, JSON.stringify(withKey));
  assert.equal(withKey.meta.phone.ok, true);
  assert.equal(withKey.meta.phone.data.quality_rating, 'GREEN');
  assert.equal(withKey.meta.messagingLimit.data, 'TIER_250');
  assert.equal(withKey.meta.subscribedApps.data[0].override_callback_uri, 'https://example.com/hook');
  assert.equal(withKey.meta.ownership.ok, false, 'a part Meta refuses says why and hides nothing else');
  assert.match(withKey.meta.ownership.error, /ownership not readable/);
  assert.equal(withKey.meta.token.ok, true);
  const text = JSON.stringify(withKey);
  assert.equal(text.includes(META_TOKEN) || text.includes('ciphertext') || text.includes('encAccessToken'), false, 'no token anywhere in the answer');

  const signedIn = await (await post('/getNumber', { phoneNumberId: '9801' }, asUser())).json();
  assert.equal(signedIn.meta, undefined, 'a plain read never asks Meta');
  assert.equal(signedIn.ok, true);
  assert.ok(signedIn.nextRefreshAt > Date.now(), 'and says when Meta may be asked again');
  assert.equal((await post('/getNumber', { phoneNumberId: '9801', refresh: true }, asUser())).status, 401, 'a refresh needs the key, not a sign-in');

  // Meta is not asked twice within ten minutes: the second refresh is refused, with the stored status.
  const again = await post('/getNumber', { apiKey: KEY, phoneNumberId: '9801', refresh: true });
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) > 0);
  const refusedBody = await again.json();
  assert.match(refusedBody.error, /can be asked again/);
  assert.ok(refusedBody.number.hasToken !== undefined, 'the stored data comes with it');
  const plain = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '9801' })).json();
  assert.equal(plain.meta, undefined, 'a read without refresh is always allowed');
});

test('a display name change is refused while one is in review, and goes to Meta otherwise', async () => {
  await seedNumber('9803', '9813');
  const waiting = await post('/setDisplayName', { phoneNumberId: '9803', apiKey: KEY, displayName: 'New Shop Name' });
  assert.equal(waiting.status, 409);
  assert.match((await waiting.json()).error, /already in review/);

  await seedNumber('9806', '9816');
  const accepted = await post('/setDisplayName', { phoneNumberId: '9806', apiKey: KEY, displayName: 'New Shop Name' });
  assert.equal(accepted.status, 200);
  assert.ok((await metaCalls()).some((c) => c.startsWith('POST /9806?new_display_name=New%20Shop%20Name')), 'Meta was asked');

  assert.equal((await post('/setDisplayName', { phoneNumberId: '9806', apiKey: KEY, displayName: 'No' })).status, 400);
  assert.equal((await post('/setDisplayName', { phoneNumberId: '9806', apiKey: NEW_KEY, displayName: 'New Shop Name' })).status, 401);
});

// ---- what Meta's webhooks do to a number's gates, and the notifications ----

const crypto = require('node:crypto');
const WEBHOOK_SECRET = () => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '.env'), 'utf8').match(/^META_APP_SECRET=(.*)$/m)[1].trim();
const hook = (wabaId, field, value, time = Math.floor(Date.now() / 1000)) => ({ object: 'whatsapp_business_account', entry: [{ id: wabaId, time, changes: [{ field, value }] }] });
const send = (body) => {
  const raw = JSON.stringify(body);
  return fetch(`${FUNCTIONS_BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET()).update(raw).digest('hex') }, body: raw });
};
const relayTo = (id, body) => fetch(`${FUNCTIONS_BASE}/numbers/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
const notificationsOf = async (id, query = '') => (await (await fetch(`${FUNCTIONS_BASE}/numbers/${id}/notifications${query}`, { headers: { Authorization: `Bearer ${KEY}` } })).json());
const aTemplate = (name = 'hello') => ({ messaging_product: 'whatsapp', to: '15551234567', type: 'template', template: { name, language: { code: 'en_US' } } });
const aText = { messaging_product: 'whatsapp', to: '15551234567', type: 'text', text: { body: 'hi' } };
const nowS = () => Math.floor(Date.now() / 1000);

test('the notifications come newest first in pages, only to the owner, and never hold a message', async () => {
  await seedNumber('9907', '9917');
  for (let i = 0; i < 5; i++) await send(hook('9917', 'security', { n: i }, nowS() + i));
  await send(hook('9917', 'messages', { messages: [{ text: { body: 'a customer wrote this' } }] }, nowS() + 10));
  const first = await notificationsOf('9907', '?limit=2');
  assert.equal(first.notifications.length, 2);
  assert.ok(first.nextBefore);
  const second = await notificationsOf('9907', `?limit=2&before=${first.nextBefore}`);
  assert.equal(second.notifications.length, 2);
  assert.ok(first.notifications[1].eventAt > second.notifications[0].eventAt, 'older and older');
  const all = await notificationsOf('9907', '?limit=50');
  assert.equal(all.notifications.length, 5, 'the customer message was not kept');
  assert.equal(JSON.stringify(all).includes('a customer wrote this'), false);
  assert.equal((await fetch(`${FUNCTIONS_BASE}/numbers/9502/notifications`, { headers: { Authorization: `Bearer ${KEY}` } })).status, 404, 'not another account\'s number');
  assert.equal((await fetch(`${FUNCTIONS_BASE}/numbers/9907/notifications`, { headers: { Authorization: `Bearer ${NEW_KEY}` } })).status, 401);
});

// ---- sending is gated by what is stored in health, whatever put it there ----

const seedHealth = (id, health, extra = {}) => db.collection('phoneNumbers').doc(id).update({ health, ...extra });
const issue = (send, extra = {}) => ({ send, title: 'a title', message: 'a message', at: 1, ...extra });
const healthOf = async (id) => (await post('/getNumber', { apiKey: KEY, phoneNumberId: id })).json().then((r) => r.number.health);

test('stored issues decide sending: disable stops everything, block stops templates, a cap limits the day, a paused template is refused by name', async () => {
  await seedNumber('9701', '9711');
  await seedHealth('9701', { account: { ban: issue('disable') } });
  assert.equal((await relayTo('9701', aText)).status, 403);
  assert.equal((await relayTo('9701', aTemplate())).status, 403);

  await seedNumber('9702', '9712');
  await seedHealth('9702', { account: { payment: issue('block') } });
  const blocked = await relayTo('9702', aTemplate());
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).issues[0].title, 'a title', 'it says why');
  assert.equal((await relayTo('9702', aText)).status, 200, 'a reply still goes');

  await seedNumber('9703', '9713');
  await seedHealth('9703', { phone: { cooldown: issue('block', { until: Date.now() + 3_600_000 }) } });
  const paused = await relayTo('9703', aTemplate());
  assert.equal(paused.status, 429, 'a pause with an end is a wait, not a refusal');
  assert.ok(Number(paused.headers.get('retry-after')) > 3000);

  await seedNumber('9704', '9714');
  await seedHealth('9704', { phone: { quality: issue('limit', { cap: { day: 3 } }) }, tier: 250 });
  assert.equal((await healthOf('9704')).limits.day, 3, 'the lowest ceiling wins over Meta\'s 250');
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await relayTo('9704', aTemplate())).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);

  await seedNumber('9705', '9715');
  await db.collection('phoneNumbers').doc('9705').update({ templates: { 'promo|en_US': { status: 'PAUSED', at: 1 } } });
  assert.equal((await relayTo('9705', aTemplate('promo'))).status, 403);
  assert.equal((await relayTo('9705', aTemplate('hello'))).status, 200);
});

test('Meta\'s webhooks update health: a ban and its lifting leave another issue alone, a flagged number is capped, and a repeat is kept once', async () => {
  await seedNumber('9721', '9731');
  await seedHealth('9721', { account: { payment: issue('block') } });
  const ban = hook('9731', 'account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: ['DISABLE'] } }, nowS());
  assert.equal((await send(ban)).status, 200);
  assert.equal((await send(ban)).status, 200, 'Meta retries');
  assert.equal((await healthOf('9721')).status, 'disable');
  const notes = (await notificationsOf('9721')).notifications;
  assert.equal(notes.length, 1, 'stored once');
  assert.ok((await db.collection('phoneNumbers').doc('9721').collection('notifications').get()).docs[0].data().expireAt, 'with an expiry for the clean-up');

  assert.equal((await send(hook('9731', 'account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }, nowS() + 5))).status, 200);
  const lifted = await healthOf('9721');
  assert.equal(lifted.status, 'block', 'the payment problem is still there');
  assert.deepEqual(Object.keys((await db.collection('phoneNumbers').doc('9721').get()).data().health.account), ['payment']);

  assert.equal((await send(hook('9731', 'phone_number_quality_update', { display_phone_number: '1', event: 'FLAGGED', current_limit: 'TIER_10K' }, nowS() + 10))).status, 200);
  assert.equal((await healthOf('9721')).limits.day, 5, 'flagged: a few a day, under Meta\'s 10K');
  assert.equal((await send(hook('999999999', 'account_update', { event: 'ACCOUNT_DELETED' }))).status, 200, 'an account we do not hold is not an error');
});

test('refreshing from Meta stores what it finds and replaces what a webhook set', async () => {
  await seedNumber('9801', '9811');
  const blocked = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '9801', refresh: true })).json();
  assert.equal(blocked.number.health.status, 'block');
  assert.equal(blocked.number.health.scopes.account.issues[0].title, 'Payment method problem');
  assert.equal(blocked.number.health.limits.day, 250, 'Meta\'s daily limit');
  assert.ok((await db.collection('phoneNumbers').doc('9801').get()).data().health.account.payment, 'stored');
  assert.equal((await relayTo('9801', aTemplate())).status, 403);
  assert.equal((await relayTo('9801', aText)).status, 200);

  await seedNumber('9802', '9812');
  const limited = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '9802', refresh: true })).json();
  assert.equal(limited.number.health.status, 'limit');
  assert.deepEqual(Object.keys(limited.number.health.scopes).sort(), ['business', 'display_name']);
  assert.equal(limited.number.health.limits.day, 5);

  await seedNumber('9805', '9815');
  await send(hook('9815', 'account_update', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }, nowS() - 100));
  assert.equal((await healthOf('9805')).status, 'disable');
  const fine = await (await post('/getNumber', { apiKey: KEY, phoneNumberId: '9805', refresh: true })).json();
  assert.equal(fine.number.health.status, 'ok', 'Meta says the number is fine');
  assert.ok((await notificationsOf('9805')).notifications.some((n) => n.field === 'refresh'), 'and the disagreement is written down');
});

test('a send Meta refuses is remembered: a payment problem blocks templates, a spam rate limit pauses them for an hour', async () => {
  await seedNumber('9804', '9814');
  assert.equal((await relayTo('9804', aText)).status, 400);
  assert.ok((await db.collection('phoneNumbers').doc('9804').get()).data().health.account.payment);
  assert.equal((await relayTo('9804', aTemplate())).status, 403);

  await seedNumber('9908', '9918');
  assert.equal((await relayTo('9908', aTemplate())).status, 400, 'Meta refuses with the spam rate limit');
  const paused = await relayTo('9908', aTemplate());
  assert.equal(paused.status, 429);
  assert.ok(Number(paused.headers.get('retry-after')) > 3000, 'an hour');
  assert.equal((await metaCalls()).filter((c) => c === 'POST /9908/messages').length, 1, 'the second never reached Meta');
  assert.ok((await notificationsOf('9908')).notifications.some((n) => n.field === 'send'));
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
