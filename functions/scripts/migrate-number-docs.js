#!/usr/bin/env node
// One-off: brings the stored data to the shape the code now reads.
//
//   users/{id}            gets `phoneNumbers`, the ids of the numbers that name the user as owner
//   phoneNumbers/{id}     loses `phoneNumberId` (the document id is it) and `platformType`;
//                         `callbackSkipped` moves into `onboarding`;
//                         in `health`, the `phone` scope is now `number`, and the `display_name` scope is gone
//                         (status and limits are worked out again)
//
// Run it right after deploying the functions: until then the new code does not read the old places.
//   cd functions && npm run build
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/migrate-number-docs.js          # shows what would change
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/migrate-number-docs.js --apply  # does it
// Safe to run twice: a document already in the new shape is left alone.
const admin = require('firebase-admin');
const { FieldValue } = admin.firestore;
const { settle } = require('../lib/helpers/rules');

const apply = process.argv.includes('--apply');
admin.initializeApp();
const db = admin.firestore();

/** What to change on a number document, or null when it is already in the new shape. */
function numberChanges(data) {
  const changes = {};
  if ('phoneNumberId' in data) changes.phoneNumberId = FieldValue.delete();
  if ('platformType' in data) changes.platformType = FieldValue.delete();
  if ('callbackSkipped' in data) {
    changes.callbackSkipped = FieldValue.delete();
    if (data.callbackSkipped && data.onboarding) changes['onboarding.callbackSkipped'] = true;
  }
  const health = data.health;
  if (health && ('phone' in health || 'display_name' in health)) {
    const { phone, display_name: _gone, status: _status, limits: _limits, ...rest } = health;
    changes.health = settle({ ...rest, ...(phone ? { number: phone } : {}) }, Date.now());
  }
  return Object.keys(changes).length ? changes : null;
}

async function main() {
  console.log(apply ? 'Applying.' : 'Dry run: nothing is written. Add --apply to write.');
  const numbers = await db.collection('phoneNumbers').get();
  const owned = {};
  for (const snap of numbers.docs) {
    const data = snap.data();
    (owned[data.userId] ||= []).push(snap.id);
    const changes = numberChanges(data);
    if (!changes) continue;
    console.log(`phoneNumbers/${snap.id}: ${Object.keys(changes).join(', ')}`);
    if (apply) await snap.ref.update(changes);
  }

  const users = await db.collection('users').get();
  for (const snap of users.docs) {
    const ids = owned[snap.id] ?? [];
    const have = snap.data().phoneNumbers;
    if (Array.isArray(have) && ids.every((id) => have.includes(id))) continue;
    console.log(`users/${snap.id}: phoneNumbers = [${ids.join(', ')}]`);
    if (apply) await snap.ref.update({ phoneNumbers: [...new Set([...(have ?? []), ...ids])] });
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
