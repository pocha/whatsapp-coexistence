import { FieldValue, getFirestore, type DocumentSnapshot } from 'firebase-admin/firestore';
import { effectiveConfig, reserve, type Verdict } from './rateLimiter';
import type { RateLimitConfig } from './rateLimitConfig';
import { LIMITED_DAILY_TEMPLATES } from './health';
import type {
  DisplayNameState,
  EncryptedToken,
  NumberHealth,
  OnboardingState,
  OnboardingStep,
  PhoneNumberDoc,
  SignupEvent,
  SyncStatus,
  SyncType,
  TestEventType,
  UserDoc,
} from './types';

// Every read and write of Firestore, in one place: the collections and what they hold, and a
// named function for each thing the other files need done. Nothing outside this file touches
// Firestore, so the data model can be read, and changed, here. Server only (the browser reads
// Firestore through its own SDK and shares just the types).
//
//   users/{userId}                phoneNumber, apiKeyHash, createdAt, rotatedAt
//   phoneIndex/{phone}            userId (makes phone -> user creation race-free)
//   phoneNumbers/{phoneNumberId}  one per onboarded number: see PhoneNumberDoc in types.ts
//   otps/{phone}                  sign-in codes (no browser can read them)
//   testRuns/{userId}             the codes of the last "send test data" (no browser can read them)
//   meta/waitlist                 the waitlist click counter
//
// This file knows nothing about HTTP, keys or Meta: where a rule is decided by the caller, it is
// passed in (see moveStep and replaceApiKey), and where a request can be refused for a reason,
// the answer says which and the caller turns it into a message.

// Functions rather than constants because getFirestore() can only be called once the app is
// initialised (index.ts does that first).
const db = () => getFirestore();
const phoneNumbers = () => db().collection('phoneNumbers');
const phoneNumberRef = (phoneNumberId: string) => phoneNumbers().doc(phoneNumberId);
const users = () => db().collection('users');
const userRef = (userId: string) => users().doc(userId);
const phoneIndexRef = (phone: string) => db().collection('phoneIndex').doc(phone);
const otpRef = (phone: string) => db().collection('otps').doc(phone);
const testRunRef = (userId: string) => db().collection('testRuns').doc(userId);
const waitlistRef = () => db().collection('meta').doc('waitlist');

const numberOf = (snap: DocumentSnapshot) => snap.data() as PhoneNumberDoc | undefined;
const userOf = (snap: DocumentSnapshot) => snap.data() as UserDoc | undefined;

// ---- users ----

export interface UserRecord {
  userId: string;
  phoneNumber: string;
  apiKeyHash?: string;
}

/** Finds the user for a phone number, creating one (with a random id) if none exists. */
export async function getOrCreateUserByPhone(phone: string): Promise<UserRecord> {
  return db().runTransaction(async (tx) => {
    const indexRef = phoneIndexRef(phone);
    const indexSnap = await tx.get(indexRef);

    if (indexSnap.exists) {
      const userId = indexSnap.data()!.userId as string;
      const userSnap = await tx.get(userRef(userId));
      return { userId, phoneNumber: phone, apiKeyHash: userOf(userSnap)?.apiKeyHash };
    }

    const newUser = users().doc();
    tx.set(newUser, { phoneNumber: phone, createdAt: Date.now() });
    tx.set(indexRef, { userId: newUser.id });
    return { userId: newUser.id, phoneNumber: phone };
  });
}

/** The user whose key hashes to this, if any. */
export async function userIdByKeyHash(apiKeyHash: string): Promise<string | undefined> {
  return (await users().where('apiKeyHash', '==', apiKeyHash).limit(1).get()).docs[0]?.id;
}

export async function getUser(userId: string): Promise<UserRecord | undefined> {
  const data = userOf(await userRef(userId).get());
  if (!data) return undefined;
  return { userId, phoneNumber: data.phoneNumber, apiKeyHash: data.apiKeyHash };
}

/** Saves the hash of a user's first API key. Only allowed while they have none. */
export async function setFirstApiKeyHash(userId: string, apiKeyHash: string): Promise<'ok' | 'no_user' | 'has_key'> {
  const ref = userRef(userId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'no_user' as const;
    if (userOf(snap)!.apiKeyHash) return 'has_key' as const;
    tx.update(ref, { apiKeyHash, rotatedAt: Date.now() });
    return 'ok' as const;
  });
}

/**
 * Replaces a user's key hash and re-seals every stored Meta token, in one batch (all or nothing).
 * `rewrap` turns a token sealed under the old key into one sealed under the new; if it throws,
 * nothing is written.
 */
export async function replaceApiKey(userId: string, newApiKeyHash: string, rewrap: (token: EncryptedToken) => EncryptedToken): Promise<void> {
  const batch = db().batch();
  (await numbersOf(userId)).forEach((snap) => {
    const sealed = numberOf(snap)!.encAccessToken;
    if (sealed) batch.update(snap.ref, { encAccessToken: rewrap(sealed) });
  });
  batch.update(userRef(userId), { apiKeyHash: newApiKeyHash, rotatedAt: Date.now() });
  await batch.commit();
}

/**
 * For a lost key: the stored tokens can't be opened without it, so they are deleted along with
 * the key hash. The number records stay, but each must be onboarded again before it can send.
 */
export async function resetApiKey(userId: string): Promise<number> {
  const numbers = await numbersOf(userId);
  const batch = db().batch();
  let wiped = 0;
  numbers.forEach((snap) => {
    if (numberOf(snap)!.encAccessToken) wiped += 1;
    batch.update(snap.ref, { encAccessToken: FieldValue.delete() });
  });
  batch.update(userRef(userId), { apiKeyHash: FieldValue.delete(), rotatedAt: Date.now() });
  await batch.commit();
  return wiped;
}

// ---- numbers ----

export async function readNumber(phoneNumberId: string): Promise<PhoneNumberDoc | undefined> {
  return numberOf(await phoneNumberRef(phoneNumberId).get());
}

export async function listNumbersForUser(userId: string): Promise<PhoneNumberDoc[]> {
  return (await numbersOf(userId)).docs.map((snap) => numberOf(snap)!);
}

const numbersOf = (userId: string) => phoneNumbers().where('userId', '==', userId).get();

/**
 * Saves a number's sealed Meta token. The number starts (or restarts) the onboarding wizard at the
 * override step, and anything left from an earlier attempt (sync state, whether it was on the
 * Business app, its status) is cleared.
 */
export async function saveNumberToken(args: {
  userId: string;
  wabaId: string;
  phoneNumberId: string;
  encAccessToken: EncryptedToken;
  event: SignupEvent;
}): Promise<'ok' | 'owned_by_other'> {
  const ref = phoneNumberRef(args.phoneNumberId);
  return db().runTransaction(async (tx) => {
    const existing = numberOf(await tx.get(ref));
    // A number that belongs to another Watobot account is never taken over by a sign-up.
    if (existing && existing.userId !== args.userId) return 'owned_by_other' as const;
    tx.set(
      ref,
      {
        userId: args.userId,
        wabaId: args.wabaId,
        phoneNumberId: args.phoneNumberId,
        encAccessToken: args.encAccessToken,
        onboarding: { step: 'override', event: args.event, updatedAt: Date.now() },
        sync: FieldValue.delete(),
        isOnBizApp: FieldValue.delete(),
        platformType: FieldValue.delete(),
        metaStatus: FieldValue.delete(),
      },
      { merge: true },
    );
    return 'ok' as const;
  });
}

/** Stores what the last read from Meta said about whether the number may send, and its display name. */
export const setHealth = (phoneNumberId: string, health: NumberHealth, displayName?: DisplayNameState) =>
  phoneNumberRef(phoneNumberId).update({ health, ...(displayName ? { displayName } : {}) });

export const setDisplayPhoneNumber = (phoneNumberId: string, displayPhoneNumber: string) =>
  phoneNumberRef(phoneNumberId).update({ displayPhoneNumber });

/** Records where incoming events go: the user's URL, or (with none) that they chose to receive none. */
export const setCallback = (phoneNumberId: string, overrideUrl?: string) =>
  phoneNumberRef(phoneNumberId).update(
    overrideUrl
      ? { overrideUrl, callbackSkipped: FieldValue.delete(), activatedAt: Date.now() }
      : { overrideUrl: FieldValue.delete(), callbackSkipped: true, activatedAt: Date.now() },
  );

/** The wizard state moved to a new step, with the previous failure cleared. */
export function movedTo(current: OnboardingState, step: OnboardingStep): OnboardingState {
  const { error: _cleared, ...rest } = current;
  return { ...rest, step, updatedAt: Date.now() };
}

/** Keeps the last failure on the number's wizard step, so the dashboard can show it with a way to try again. */
export async function noteOnboardingError(phoneNumberId: string, step: OnboardingStep, message: string): Promise<void> {
  const current = (await readNumber(phoneNumberId))?.onboarding;
  if (current?.step === step) {
    await phoneNumberRef(phoneNumberId).update({ 'onboarding.error': message.slice(0, 500), 'onboarding.updatedAt': Date.now() });
  }
}

/** What Meta said about the number once the callback URL was subscribed, and where the wizard goes next. */
export async function recordOverrideResult(
  phoneNumberId: string,
  result: { onboarding: OnboardingState; isOnBizApp: boolean; metaStatus?: string; platformType?: string; startSync: boolean; skipSync?: boolean },
): Promise<void> {
  await phoneNumberRef(phoneNumberId).update({
    isOnBizApp: result.isOnBizApp,
    ...(result.metaStatus ? { metaStatus: result.metaStatus } : {}),
    platformType: result.platformType ?? FieldValue.delete(),
    ...(result.startSync ? { sync: { contacts: { state: 'none' }, history: { state: 'none' } } } : {}),
    ...(result.skipSync ? { sync: { contacts: { state: 'skipped', at: Date.now() }, history: { state: 'skipped', at: Date.now() } } } : {}),
    onboarding: result.onboarding,
  });
}

/** The number is registered with Meta; the wizard moves on if it was waiting for that. */
export const markRegistered = (phoneNumberId: string, onboarding?: OnboardingState) =>
  phoneNumberRef(phoneNumberId).update({ metaStatus: 'CONNECTED', ...(onboarding ? { onboarding } : {}) });

/** The number was taken off the Cloud API, so it is API-only and not connected. */
export const markDeregistered = (phoneNumberId: string) =>
  phoneNumberRef(phoneNumberId).update({ metaStatus: 'DEREGISTERED', isOnBizApp: false });

export const setTemplateSource = (phoneNumberId: string, sourceWabaId: string) =>
  phoneNumberRef(phoneNumberId).update({ 'onboarding.templateSourceWabaId': sourceWabaId });

/**
 * Moves a number's wizard to another step if `decide` allows it (it is given the record, inside a
 * transaction, and answers with the step to move to, or null to refuse). Answers the new step, or null.
 */
export async function moveStep(phoneNumberId: string, decide: (doc: PhoneNumberDoc) => OnboardingStep | null): Promise<OnboardingStep | null> {
  const ref = phoneNumberRef(phoneNumberId);
  return db().runTransaction(async (tx) => {
    const doc = numberOf(await tx.get(ref))!;
    const to = decide(doc);
    if (!to) return null;
    tx.update(ref, { onboarding: movedTo(doc.onboarding, to) });
    return to;
  });
}

// ---- the contacts and history syncs ----

// A request that has been "requesting" longer than this died with its function instance.
const REQUESTING_STALE_MS = 2 * 60 * 1000;

/**
 * Claims the right to ask Meta for one of the two syncs, so two clicks cannot both send it. Meta
 * allows each only once: it is refused once accepted, while one is in flight, and for the history
 * before the contacts. A failed request can be claimed again.
 */
export async function claimSync(
  phoneNumberId: string,
  type: SyncType,
): Promise<'ok' | 'not_at_step' | 'already_requested' | 'in_flight' | 'contacts_first'> {
  const ref = phoneNumberRef(phoneNumberId);
  return db().runTransaction(async (tx) => {
    const doc = numberOf(await tx.get(ref))!;
    if (doc.onboarding.step !== 'sync') return 'not_at_step' as const;
    const current = doc.sync?.[type];
    if (current?.state === 'requested') return 'already_requested' as const;
    if (current?.state === 'requesting' && Date.now() - (current.at ?? 0) < REQUESTING_STALE_MS) return 'in_flight' as const;
    if (type === 'history' && doc.sync?.contacts?.state !== 'requested') return 'contacts_first' as const;
    tx.update(ref, { [`sync.${type}`]: { state: 'requesting', at: Date.now() } });
    return 'ok' as const;
  });
}

/**
 * The user chooses not to request the syncs. Whatever is not requested yet is marked skipped (Meta
 * allows each once, so it can't be done later) and the wizard moves on. Refused outside the sync step.
 */
export async function skipSync(phoneNumberId: string): Promise<'ok' | 'not_at_step'> {
  const ref = phoneNumberRef(phoneNumberId);
  return db().runTransaction(async (tx) => {
    const doc = numberOf(await tx.get(ref))!;
    if (doc.onboarding.step !== 'sync') return 'not_at_step' as const;
    const now = Date.now();
    const skipped = (type: SyncType): SyncStatus => (doc.sync?.[type]?.state === 'requested' ? doc.sync[type]! : { state: 'skipped', at: now });
    tx.update(ref, { sync: { contacts: skipped('contacts'), history: skipped('history') }, onboarding: movedTo(doc.onboarding, 'templates') });
    return 'ok' as const;
  });
}

export const setSyncState = (phoneNumberId: string, type: SyncType, status: SyncStatus) =>
  phoneNumberRef(phoneNumberId).update({ [`sync.${type}`]: status });

// ---- sending ----

/**
 * Counts one more template message against the number's windows, and says whether it may go. The
 * check and the count happen in one transaction, so sends arriving together cannot all slip under
 * the limit. Limits come from helpers/rateLimitConfig.ts, overridden per number by `rateLimits`.
 */
export async function reserveTemplateSend(
  phoneNumberId: string,
): Promise<{ verdict: Verdict | { allowed: true } | { allowed: false; blocked: NumberHealth }; config: RateLimitConfig; now: number }> {
  const ref = phoneNumberRef(phoneNumberId);
  const now = Date.now();
  return db().runTransaction(async (tx) => {
    const data = numberOf(await tx.get(ref));
    // A blocked number sends no template (business-initiated) messages at all, and a limited one only a few
    // a day. Both come from the status stored at the last read from Meta (see health.ts).
    if (data?.health?.status === 'blocked') return { verdict: { allowed: false as const, blocked: data.health }, config: effectiveConfig(data.rateLimits), now };
    const override = data?.health?.status === 'limited' ? { ...data.rateLimits, headroomSigmas: 0, day: { ...data.rateLimits?.day, floor: LIMITED_DAILY_TEMPLATES, growthPercent: 0 } } : data?.rateLimits;
    const config = effectiveConfig(override);
    if (!config.enabled) return { verdict: { allowed: true as const }, config, now };
    const verdict = reserve(data?.rateState, config, now);
    tx.update(ref, { rateState: verdict.state });
    return { verdict, config, now };
  });
}

/**
 * Metadata only (when, and how it went; never the message content or any token), and only a
 * successful send counts towards billable usage. Best-effort: a failure here must not change what
 * the caller sees, and update() never creates a record.
 */
export async function recordRelayCall(
  phoneNumberId: string,
  call: { at: number; ok: boolean; statusCode: number; usageKeys: { daily: string; weekly: string; monthly: string } },
): Promise<void> {
  const update: Record<string, unknown> = { lastRelayCall: { at: call.at, ok: call.ok, statusCode: call.statusCode } };
  if (call.ok) {
    update[`usage.daily.${call.usageKeys.daily}`] = FieldValue.increment(1);
    update[`usage.weekly.${call.usageKeys.weekly}`] = FieldValue.increment(1);
    update[`usage.monthly.${call.usageKeys.monthly}`] = FieldValue.increment(1);
  }
  try {
    await phoneNumberRef(phoneNumberId).update(update);
  } catch {
    // No record to update.
  }
}

// ---- test data for a user's own endpoint ----

export interface TestRun {
  codes: Record<TestEventType, string>;
  sentAt: number;
}

/** Saves the codes of a send, unless the last one was too recent. Answers the seconds to wait, or 0 if it was saved. */
export async function reserveTestSend(userId: string, codes: Record<TestEventType, string>, gapMs: number): Promise<number> {
  const ref = testRunRef(userId);
  return db().runTransaction(async (tx) => {
    const last = (await tx.get(ref)).data() as { sentAt?: number } | undefined;
    const elapsed = Date.now() - (last?.sentAt ?? 0);
    if (elapsed < gapMs) return Math.ceil((gapMs - elapsed) / 1000);
    tx.set(ref, { codes, sentAt: Date.now() });
    return 0;
  });
}

export async function readTestRun(userId: string): Promise<TestRun | undefined> {
  return (await testRunRef(userId).get()).data() as TestRun | undefined;
}

// ---- sign-in codes ----

export async function readOtp<T>(phone: string): Promise<T | undefined> {
  return (await otpRef(phone).get()).data() as T | undefined;
}
export const saveOtp = (phone: string, data: Record<string, unknown>) => otpRef(phone).set(data);
export const deleteOtp = (phone: string) => otpRef(phone).delete();
export const countOtpAttempt = (phone: string) => otpRef(phone).update({ attempts: FieldValue.increment(1) });

// ---- waitlist ----

/** Counts one more click on the waitlist button; simultaneous clicks are all counted. */
export async function incrementWaitlist(): Promise<number> {
  return db().runTransaction(async (tx) => {
    const counter = waitlistRef();
    const current = ((await tx.get(counter)).data()?.count as number | undefined) ?? 0;
    tx.set(counter, { count: current + 1 });
    return current + 1;
  });
}
