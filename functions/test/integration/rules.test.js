const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

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

async function seed(phoneNumberId, userId) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('wabas').doc(phoneNumberId).set({
      userId,
      wabaId: 'w',
      phoneNumberId,
      encAccessToken: { ciphertext: 'x', iv: 'y', authTag: 'z' },
      overrideUrl: 'https://old.example.com',
      usage: { daily: { '2026-10-01': 1 } },
    });
  });
}

test('an owner can read their own number and change only the override URL and activation time', async () => {
  await seed('phone-1', 'owner-1');
  const doc = testEnv.authenticatedContext('owner-1').firestore().collection('wabas').doc('phone-1');
  await assertSucceeds(doc.get());
  await assertSucceeds(doc.update({ overrideUrl: 'https://new.example.com', activatedAt: 5 }));
});

test('an owner cannot write the token, usage, ownership or any other backend-owned field', async () => {
  await seed('phone-2', 'owner-1');
  const doc = testEnv.authenticatedContext('owner-1').firestore().collection('wabas').doc('phone-2');
  await assertFails(doc.update({ encAccessToken: { ciphertext: 'a', iv: 'b', authTag: 'c' } }));
  await assertFails(doc.update({ usage: { daily: { '2026-10-01': 999999 } } }));
  await assertFails(doc.update({ lastRelayCall: { ok: true } }));
  await assertFails(doc.update({ userId: 'someone-else' }));
});

test('browsers cannot create or delete a number record', async () => {
  const ownerDb = testEnv.authenticatedContext('owner-1').firestore();
  await assertFails(ownerDb.collection('wabas').doc('phone-new').set({ userId: 'owner-1', wabaId: 'w', phoneNumberId: 'phone-new' }));
  await seed('phone-3', 'owner-1');
  await assertFails(ownerDb.collection('wabas').doc('phone-3').delete());
});

test('another user, or nobody, cannot read a number', async () => {
  await seed('phone-4', 'owner-1');
  await assertFails(testEnv.authenticatedContext('stranger').firestore().collection('wabas').doc('phone-4').get());
  await assertFails(testEnv.unauthenticatedContext().firestore().collection('wabas').doc('phone-4').get());
});

test('a user can read only their own user doc, and never write it', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('users').doc('owner-1').set({ phoneNumber: '1', apiKeyHash: 'h' });
  });
  const ownerDb = testEnv.authenticatedContext('owner-1').firestore();
  await assertSucceeds(ownerDb.collection('users').doc('owner-1').get());
  await assertFails(ownerDb.collection('users').doc('owner-1').update({ apiKeyHash: 'mine' }));
  await assertFails(testEnv.authenticatedContext('stranger').firestore().collection('users').doc('owner-1').get());
  await assertFails(testEnv.unauthenticatedContext().firestore().collection('users').doc('owner-1').get());
});

test('phoneIndex and otps are not reachable from a browser at all', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('phoneIndex').doc('1').set({ userId: 'owner-1' });
    await ctx.firestore().collection('otps').doc('1').set({ code: '1' });
  });
  const ownerDb = testEnv.authenticatedContext('owner-1').firestore();
  await assertFails(ownerDb.collection('phoneIndex').doc('1').get());
  await assertFails(ownerDb.collection('otps').doc('1').get());
});
