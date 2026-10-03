const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

const { FieldValue } = firebase.firestore;
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'wa-coexistence-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

const ENC = { ciphertext: 'x', iv: 'y', authTag: 'z' };

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.collection('users').doc('owner-1').set({ phoneNumber: '919000000001', apiKeyHash: 'h', createdAt: 1 });
    await db.collection('phoneIndex').doc('919000000001').set({ userId: 'owner-1' });
    await db.collection('wabas').doc('phone-1').set({
      userId: 'owner-1',
      wabaId: 'w1',
      phoneNumberId: 'phone-1',
      encAccessToken: ENC,
      overrideUrl: 'https://old.example.com',
      usage: { daily: { '2026-10-01': 1 } },
    });
    await db.collection('users').doc('owner-2').set({ phoneNumber: '919000000002' });
    await db.collection('phoneIndex').doc('919000000002').set({ userId: 'owner-2' });
    await db.collection('wabas').doc('phone-2').set({ userId: 'owner-2', wabaId: 'w2', phoneNumberId: 'phone-2' });
  });
});

const as = (uid) => testEnv.authenticatedContext(uid).firestore();

test('an owner reads their own number, and can change the override URL, activation time and token', async () => {
  const doc = as('owner-1').collection('wabas').doc('phone-1');
  await assertSucceeds(doc.get());
  await assertSucceeds(doc.update({ overrideUrl: 'https://new.example.com', activatedAt: 5 }));
  await assertSucceeds(doc.update({ encAccessToken: { ciphertext: 'a', iv: 'b', authTag: 'c' } }));
});

test('an owner cannot change ownership, usage, the last call, or the ids on a number', async () => {
  const doc = as('owner-1').collection('wabas').doc('phone-1');
  await assertFails(doc.update({ userId: 'owner-2' }));
  await assertFails(doc.update({ usage: { daily: { '2026-10-01': 999999 } } }));
  await assertFails(doc.update({ lastRelayCall: { ok: true } }));
  await assertFails(doc.update({ wabaId: 'other' }));
});

test('no browser can create a number record; only the owner can delete theirs', async () => {
  await assertFails(as('owner-1').collection('wabas').doc('phone-new').set({ userId: 'owner-1', wabaId: 'w', phoneNumberId: 'phone-new' }));
  await assertFails(as('owner-1').collection('wabas').doc('phone-2').delete());
  await assertSucceeds(as('owner-1').collection('wabas').doc('phone-1').delete());
});

test('another user, or nobody, cannot read a number or touch it', async () => {
  await assertFails(as('stranger').collection('wabas').doc('phone-1').get());
  await assertFails(as('stranger').collection('wabas').doc('phone-1').update({ overrideUrl: 'x' }));
  await assertFails(testEnv.unauthenticatedContext().firestore().collection('wabas').doc('phone-1').get());
});

test('a user reads their own record and can set or replace apiKeyHash, but not their phone number', async () => {
  const doc = as('owner-1').collection('users').doc('owner-1');
  await assertSucceeds(doc.get());
  await assertSucceeds(doc.update({ apiKeyHash: 'new-hash', rotatedAt: 2 }));
  await assertFails(doc.update({ phoneNumber: '919999999999' }));
  await assertFails(as('owner-1').collection('users').doc('brand-new').set({ phoneNumber: '1' }));
});

test('nobody else can read or change a user record', async () => {
  await assertFails(as('stranger').collection('users').doc('owner-1').get());
  await assertFails(as('stranger').collection('users').doc('owner-1').update({ apiKeyHash: 'mine' }));
  await assertFails(testEnv.unauthenticatedContext().firestore().collection('users').doc('owner-1').get());
});

test('rotating a key from the browser: re-encrypt every number and replace the hash in one batch', async () => {
  const db = as('owner-1');
  const batch = db.batch();
  batch.update(db.collection('wabas').doc('phone-1'), { encAccessToken: { ciphertext: 'n', iv: 'n', authTag: 'n' } });
  batch.update(db.collection('users').doc('owner-1'), { apiKeyHash: 'new-hash', rotatedAt: 3 });
  await assertSucceeds(batch.commit());
});

test('resetting a lost key from the browser: clear the tokens and the hash, keep the records', async () => {
  const db = as('owner-1');
  const batch = db.batch();
  batch.update(db.collection('wabas').doc('phone-1'), { encAccessToken: FieldValue.delete() });
  batch.update(db.collection('users').doc('owner-1'), { apiKeyHash: FieldValue.delete(), rotatedAt: 4 });
  await assertSucceeds(batch.commit());
});

test('deleting an account from the browser: numbers, phone index entry and user, in one batch', async () => {
  const db = as('owner-1');
  const batch = db.batch();
  batch.delete(db.collection('wabas').doc('phone-1'));
  batch.delete(db.collection('phoneIndex').doc('919000000001'));
  batch.delete(db.collection('users').doc('owner-1'));
  await assertSucceeds(batch.commit());
});

test('the phone index: only the matching owner can delete an entry, and nobody can read or create one', async () => {
  const db = as('owner-1');
  await assertFails(db.collection('phoneIndex').doc('919000000002').delete());
  await assertFails(db.collection('phoneIndex').doc('919000000001').get());
  await assertFails(db.collection('phoneIndex').doc('919000000099').set({ userId: 'owner-1' }));
  await assertSucceeds(db.collection('phoneIndex').doc('919000000001').delete());
});

test('otps are not reachable from a browser at all', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('otps').doc('1').set({ code: '1' });
  });
  await assertFails(as('owner-1').collection('otps').doc('1').get());
});
