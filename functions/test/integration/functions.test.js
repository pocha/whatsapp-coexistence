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
    { code: 'fake-signup-code', wabaId: '111', phoneNumberId: '222', apiKey: KEY, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' },
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
  const body = { code: 'c', wabaId: '111', phoneNumberId: '223', apiKey: NEW_KEY, event: 'FINISH' };
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

test('template sends are rate limited per number, and free-form text is not', async () => {
  await seedNumber('556', '667');
  // A per-number override, so the test needs only a few sends: every window allows 2, with no growth.
  const tight = { floor: 2, growthPercent: 0 };
  await db.collection('phoneNumbers').doc('556').update({
    rateLimits: { headroomSigmas: 0, minute: tight, hour: tight, day: tight },
  });
  const send = (message) =>
    fetch(`${FUNCTIONS_BASE}/relayMessage/556/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567', ...message }),
    });
  const template = { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };

  assert.equal((await send(template)).status, 200);
  assert.equal((await send(template)).status, 200);
  const refused = await send(template);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1, 'tells the caller when to retry');

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
    { code: 'c', wabaId: `9${phoneNumberId}`, phoneNumberId, apiKey: KEY, event },
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

test('register refuses a number on the Business app, moves a plain number on, and keeps the step when Meta refuses', async () => {
  const register = (id) => post('/registerNumber', { phoneNumberId: id, apiKey: KEY, pin: '123456' });

  // 222 is on the Business app (see the test above).
  assert.equal((await register('222')).status, 409);
  assert.equal((await metaCalls()).some((c) => c.includes('/222/register')), false);

  await db.collection('phoneNumbers').doc('224').update({ 'onboarding.step': 'register' });
  const ok = await register('224');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).step, 'templates');

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
  const migrate = (sourceWabaId) => post('/migrateTemplates', { phoneNumberId: '222', apiKey: KEY, sourceWabaId });

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

test('reputation: the number and the non-green templates are read from Meta and kept; the webhook then updates them', async () => {
  await db.collection('phoneNumbers').doc('240').set({
    userId,
    wabaId: '9240',
    phoneNumberId: '240',
    displayPhoneNumber: '+1 555-000-1111',
    encAccessToken: encryptToken(META_TOKEN, KEY),
  });

  const number = await (await post('/numberReputation', { phoneNumberId: '240', apiKey: KEY })).json();
  assert.equal(number.status, 'CONNECTED');
  assert.equal(number.qualityRating, 'GREEN');
  const afterNumber = await numberDoc('240');
  assert.equal(afterNumber.metaStatus, 'CONNECTED');
  assert.equal(afterNumber.reputation.number.qualityRating, 'GREEN');

  const templates = await (await post('/templateReputation', { phoneNumberId: '240', apiKey: KEY })).json();
  assert.equal(templates.total, 3);
  assert.deepEqual(templates.templates.map((t) => `${t.name}:${t.score}`).sort(), ['fresh:UNKNOWN', 'meh:YELLOW']);
  assert.deepEqual(Object.keys((await numberDoc('240')).reputation.templates).sort(), ['fresh__en_US', 'meh__en_US']);

  // Meta's webhooks for the same Messaging account: the number's quality, one template turning
  // green, another going red and a third being paused.
  const event = (field, value) => ({ field, value });
  const webhook = await post('/webhook', {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '9240',
        changes: [
          event('phone_number_quality_update', { display_phone_number: '15550001111', event: 'DOWNGRADE', current_limit: 'TIER_1K' }),
          event('message_template_quality_update', { message_template_name: 'meh', message_template_language: 'en_US', new_quality_score: 'GREEN' }),
          event('message_template_quality_update', { message_template_name: 'fresh', message_template_language: 'en_US', new_quality_score: 'RED' }),
          event('message_template_status_update', { event: 'PAUSED', message_template_name: 'good', message_template_language: 'en_US' }),
        ],
      },
    ],
  });
  assert.equal(webhook.status, 200);
  const kept = (await numberDoc('240')).reputation;
  assert.equal(kept.number.event, 'DOWNGRADE');
  assert.equal(kept.number.currentLimit, 'TIER_1K');
  assert.equal(kept.number.qualityRating, 'GREEN', 'what Meta last reported is kept alongside the event');
  assert.equal(kept.templates.meh__en_US, undefined, 'a template that turned green is dropped');
  assert.equal(kept.templates.fresh__en_US.score, 'RED');
  assert.equal(kept.templates.good__en_US.status, 'PAUSED');
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
  const { effectiveStep } = require('../../lib/helpers/onboardingSteps');
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
