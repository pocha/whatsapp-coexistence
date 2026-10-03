#!/usr/bin/env node
// Stores a Meta access token for a phone number, encrypted under a Watobot API
// key, the same way onboarding does. Meant for a number you already have a token
// for (for example the test number that comes with your Meta app), so the app can
// be used and recorded before Embedded Signup is available.
//
//   META_ACCESS_TOKEN=EAAB... node scripts/seed-test-waba.js \
//     --phone 919876543210 --phone-number-id 1312040211996890 --waba-id 1082884837484295
//
// Optional: --api-key <64 hex> to use an existing key (required if the account
// already has one); otherwise a new key is generated and printed once.
// --project <id> picks the Firebase project (default wa-coexistence). It writes to
// production unless FIRESTORE_EMULATOR_HOST is set, using your gcloud credentials.
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');

const functionsDir = path.join(__dirname, '..', 'functions');
// Load firebase-admin the way the Functions code does, so both share one app.
const { initializeApp } = createRequire(path.join(functionsDir, 'package.json'))('firebase-admin/app');
const accounts = require(path.join(functionsDir, 'lib', 'accounts'));
const { isValidApiKey } = require(path.join(functionsDir, 'lib', 'apiKey'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const phone = (arg('phone') ?? '').replace(/\D/g, '');
  const phoneNumberId = arg('phone-number-id');
  const wabaId = arg('waba-id');
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phone || !phoneNumberId || !wabaId || !accessToken) {
    console.error('Need --phone, --phone-number-id, --waba-id and the META_ACCESS_TOKEN env var. See the top of this file.');
    process.exit(1);
  }

  initializeApp({ projectId: arg('project') ?? 'wa-coexistence' });

  const user = await accounts.getOrCreateUserByPhone(phone);
  let apiKey = arg('api-key');
  let generated = false;

  if (user.apiKeyHash) {
    await accounts.requireUserKey(user.userId, apiKey); // throws unless the key matches
  } else {
    apiKey = apiKey ?? randomBytes(32).toString('hex');
    if (!isValidApiKey(apiKey)) throw new Error('--api-key must be 64 hex characters.');
    await accounts.setFirstApiKey(user.userId, apiKey);
    generated = true;
  }

  await accounts.storeWabaToken({ userId: user.userId, wabaId, phoneNumberId, accessToken, apiKey });

  console.log(`Stored the token for phone number ID ${phoneNumberId} (WABA ${wabaId}) on user ${user.userId}.`);
  if (generated) console.log(`\nYour Watobot API key (shown once, keep it): ${apiKey}\n`);
  else console.log('Used the account\'s existing API key.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
