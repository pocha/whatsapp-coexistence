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

test('owner can create their own WABA doc without trusted fields', async () => {
  const ownerDb = testEnv.authenticatedContext('owner-uid').firestore();
  await assertSucceeds(
    ownerDb.collection('wabas').doc('phone-1').set({
      ownerUid: 'owner-uid',
      wabaId: 'waba-1',
      overrideUrl: 'https://business.example.com/webhook',
      activatedAt: Date.now(),
    }),
  );
});

test('owner can read and update their own onboarding-progress fields', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('wabas').doc('phone-2').set({
      ownerUid: 'owner-uid',
      wabaId: 'waba-2',
      overrideUrl: 'https://old.example.com/webhook',
    });
  });

  const ownerDb = testEnv.authenticatedContext('owner-uid').firestore();
  const doc = ownerDb.collection('wabas').doc('phone-2');

  await assertSucceeds(doc.get());
  await assertSucceeds(doc.update({ overrideUrl: 'https://new.example.com/webhook' }));
});

test('a different signed-in user cannot read someone else\'s WABA doc', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection('wabas').doc('phone-3').set({
      ownerUid: 'owner-uid',
      wabaId: 'waba-3',
    });
  });

  const strangerDb = testEnv.authenticatedContext('stranger-uid').firestore();
  await assertFails(strangerDb.collection('wabas').doc('phone-3').get());
});

test('client cannot write lastRelayCall or usage directly, even on their own doc', async () => {
  const ownerDb = testEnv.authenticatedContext('owner-uid').firestore();

  await assertFails(
    ownerDb.collection('wabas').doc('phone-4').set({
      ownerUid: 'owner-uid',
      wabaId: 'waba-4',
      lastRelayCall: { at: Date.now(), ok: true, statusCode: 200 },
    }),
  );
});
