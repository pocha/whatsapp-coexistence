import { onRequest, type Request } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import cors from 'cors';
import type { Response } from 'express';
import { HttpError, requireAuth } from './helpers/auth';
import { authenticateKey } from './accounts';
import {
  createTemplate,
  deregisterPhoneNumber,
  getNumberReputation,
  getPhoneNumberInfo,
  listTemplateScores,
  migrateTemplatesPage,
  requestSmbAppData,
  verifyWabaAccess,
} from './helpers/graphApi';
import { checkPublicUrl, verifyEndpointChallenge } from './helpers/endpointCheck';
import { config } from './helpers/config';
import { newCodes, sendTestEvent, TEST_EVENT_TYPES } from './helpers/testEvents';
import { parseTemplateExport } from './helpers/templateImport';
import { templateKey } from './helpers/reputation';
import type {
  DeregisterNumberRequest,
  ImportTemplatesRequest,
  ImportTemplatesResponse,
  MigrateTemplatesRequest,
  MigrateTemplatesResponse,
  NumberReputationResponse,
  OnboardingState,
  OnboardingStep,
  PhoneNumberDoc,
  ReputationRequest,
  SendTestEventsRequest,
  SendTestEventsResponse,
  SetOnboardingStepRequest,
  StartSyncRequest,
  SyncType,
  TemplateReputation,
  TemplateReputationResponse,
  TestEventType,
  VerifyTestCodesRequest,
  VerifyTestCodesResponse,
} from './helpers/types';

// The onboarding wizard's server side. A number gets a record, and with it an `onboarding` step,
// when Meta's popup finishes (exchangeCode). setWebhook then moves it on (see wabaManager.ts), and
// the functions here carry it through the rest: the contacts and history syncs, the register
// choice, templates and the test data the user sends to their own endpoint first.

const corsHandler = cors({ origin: true });

type Handler = (req: Request, res: Response) => Promise<void>;

/** Wraps a POST handler: CORS, method check, and Meta or validation errors turned into a JSON answer. */
function post(handler: Handler, options: { timeoutSeconds?: number } = {}) {
  return onRequest(options, (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') {
        res.status(405).send({ ok: false, error: 'Use POST' });
        return;
      }
      try {
        await handler(req, res);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 502;
        res.status(status).send({ ok: false, error: (err as Error).message });
      }
    });
  });
}

const numbers = () => getFirestore().collection('phoneNumbers');

/** The wizard state moved to a new step, with the previous failure cleared. */
export function movedTo(current: OnboardingState, step: OnboardingStep): OnboardingState {
  const { error: _cleared, ...rest } = current;
  return { ...rest, step, updatedAt: Date.now() };
}

/** Keeps the last failure on the number's wizard step, so the dashboard can show it with a way to try again. */
export async function noteOnboardingError(phoneNumberId: string, step: OnboardingStep, message: string): Promise<void> {
  const ref = numbers().doc(phoneNumberId);
  const snap = await ref.get();
  const current = (snap.data() as PhoneNumberDoc | undefined)?.onboarding;
  if (current?.step === step) await ref.update({ 'onboarding.error': message.slice(0, 500), 'onboarding.updatedAt': Date.now() });
}

/**
 * Called once the callback URL is subscribed: finds out from Meta whether the number is also on the
 * WhatsApp Business app, and moves the wizard to the next step. The coexistence event is trusted for
 * the path; `is_on_biz_app` decides it for the plain event.
 */
export async function advanceAfterOverride(phoneNumberId: string, accessToken: string): Promise<{ step: OnboardingStep; isOnBizApp?: boolean }> {
  const ref = numbers().doc(phoneNumberId);
  const doc = (await ref.get()).data() as PhoneNumberDoc;
  const info = await getPhoneNumberInfo(phoneNumberId, accessToken);
  const coexistence = doc.onboarding!.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || info.isOnBizApp === true;
  const step: OnboardingStep = coexistence ? 'sync' : 'not_on_app';
  await ref.update({
    isOnBizApp: info.isOnBizApp ?? false,
    ...(info.status ? { metaStatus: info.status } : {}),
    platformType: info.platformType ?? FieldValue.delete(),
    ...(coexistence ? { sync: { contacts: { state: 'none' }, history: { state: 'none' } } } : {}),
    onboarding: movedTo(doc.onboarding!, step),
  });
  return { step, isOnBizApp: info.isOnBizApp };
}

// ---- the callback URL, before there is a number ----

/** The same handshake Meta does, so the wizard can check the URL before the Meta popup opens. */
export const checkCallbackUrl = post(async (req, res) => {
  await requireAuth(req);
  const { overrideCallbackUrl } = (req.body ?? {}) as Partial<SendTestEventsRequest>;
  const check = await verifyEndpointChallenge(String(overrideCallbackUrl ?? ''), config.webhookVerifyToken);
  if (!check.ok) throw new HttpError(400, check.error!);
  res.status(200).send({ ok: true });
});

// ---- reputation ----

/**
 * Puts an API-only number back at the register step, so the dashboard sends the user to the wizard.
 * A number that is also on the Business app is never touched: it is registered by the app.
 */
async function markUnregistered(phoneNumberId: string, status: string): Promise<void> {
  const ref = numbers().doc(phoneNumberId);
  const doc = (await ref.get()).data() as PhoneNumberDoc;
  const update: Record<string, unknown> = { metaStatus: status };
  if (doc.isOnBizApp !== true && (!doc.onboarding || doc.onboarding.step === 'done')) {
    update.onboarding = { step: 'register', event: doc.onboarding?.event ?? 'FINISH', updatedAt: Date.now() };
  }
  await ref.update(update);
}

/** Asks Meta for the number's status and quality rating, and keeps them. A number that is not connected goes back to the register step. */
export const numberReputation = post(async (req, res) => {
  const { phoneNumberId, apiKey } = (req.body ?? {}) as Partial<ReputationRequest>;
  if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId and apiKey are required');
  const { accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const info = await getNumberReputation(String(phoneNumberId), accessToken);
  await numbers().doc(String(phoneNumberId)).update({
    ...(info.status ? { metaStatus: info.status } : {}),
    'reputation.number.qualityRating': info.qualityRating ?? null,
    'reputation.number.at': Date.now(),
  });
  if (info.status && info.status !== 'CONNECTED') await markUnregistered(String(phoneNumberId), info.status);
  const body: NumberReputationResponse = { ok: true, status: info.status, qualityRating: info.qualityRating };
  res.status(200).send(body);
});

/** Reads every template's quality score from Meta, and keeps the ones that are not green. */
export const templateReputation = post(async (req, res) => {
  const { phoneNumberId, apiKey } = (req.body ?? {}) as Partial<ReputationRequest>;
  if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId and apiKey are required');
  const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const all = await listTemplateScores(wabaId, accessToken);
  const now = Date.now();
  const flagged: TemplateReputation[] = all
    .filter((t) => t.score !== 'GREEN')
    .map((t) => ({ name: t.name, language: t.language, score: t.score, ...(t.status ? { status: t.status } : {}), at: now }));
  await numbers().doc(String(phoneNumberId)).update({
    'reputation.templates': Object.fromEntries(flagged.map((t) => [templateKey(t.name, t.language), t])),
    'reputation.templatesCheckedAt': now,
  });
  const body: TemplateReputationResponse = { ok: true, templates: flagged, total: all.length };
  res.status(200).send(body);
});

// ---- leaving the API ----

/**
 * Takes a standard (API-only) number off the Cloud API, so another provider can onboard it. A
 * number that is also on the WhatsApp Business app can't be deregistered: the way off is to
 * disconnect in the app, so that is what the answer says.
 */
export const deregisterNumber = post(async (req, res) => {
  const { phoneNumberId, apiKey } = (req.body ?? {}) as Partial<DeregisterNumberRequest>;
  if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId and apiKey are required');
  const { accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const info = await getPhoneNumberInfo(String(phoneNumberId), accessToken);
  if (info.isOnBizApp === true) {
    throw new HttpError(
      409,
      'This number is also on the WhatsApp Business app, which Meta does not allow it to be deregistered from. In the app, go to Settings > Account > Business Platform and disconnect it.',
    );
  }
  await deregisterPhoneNumber(String(phoneNumberId), accessToken);
  // Back to the register step: the dashboard sends the user to the wizard, which registers it again.
  const doc = (await numbers().doc(String(phoneNumberId)).get()).data() as PhoneNumberDoc;
  await numbers().doc(String(phoneNumberId)).update({
    metaStatus: 'DEREGISTERED',
    isOnBizApp: false,
    onboarding: { step: 'register', event: doc.onboarding?.event ?? 'FINISH', updatedAt: Date.now() },
  });
  res.status(200).send({ ok: true });
});

// ---- the contacts and history syncs ----

const META_SYNC_TYPE = { contacts: 'smb_app_state_sync', history: 'history' } as const;
// A request that has been "requesting" longer than this died with its function instance.
const REQUESTING_STALE_MS = 2 * 60 * 1000;

/**
 * Asks Meta to send the coexistence number's contacts, then its history, to the customer's callback
 * URL. Meta allows each only once, so a second request is refused once the first was accepted, and
 * a request still in flight blocks a double click. Only a request that failed can be repeated.
 */
export const startSync = post(async (req, res) => {
  const { phoneNumberId, apiKey, syncType } = (req.body ?? {}) as Partial<StartSyncRequest>;
  if (!phoneNumberId || !apiKey || (syncType !== 'contacts' && syncType !== 'history')) {
    throw new HttpError(400, 'phoneNumberId, apiKey and a syncType of contacts or history are required');
  }
  const { accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const ref = numbers().doc(String(phoneNumberId));
  const type: SyncType = syncType;

  // Claim the request in a transaction, so two clicks cannot both send it.
  await getFirestore().runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data() as PhoneNumberDoc;
    if (doc.onboarding?.step !== 'sync') throw new HttpError(409, 'This number is not at the sync step.');
    const current = doc.sync?.[type];
    const inFlight = current?.state === 'requesting' && Date.now() - (current.at ?? 0) < REQUESTING_STALE_MS;
    if (current?.state === 'requested') throw new HttpError(409, `The ${type} sync was already requested. Meta allows it only once.`);
    if (inFlight) throw new HttpError(409, `The ${type} sync is being requested.`);
    if (type === 'history' && doc.sync?.contacts?.state !== 'requested') {
      throw new HttpError(409, 'Request the contacts sync first.');
    }
    tx.update(ref, { [`sync.${type}`]: { state: 'requesting', at: Date.now() } });
  });

  try {
    await requestSmbAppData(String(phoneNumberId), accessToken, META_SYNC_TYPE[type]);
  } catch (err) {
    const message = (err as Error).message;
    await ref.update({ [`sync.${type}`]: { state: 'failed', at: Date.now(), error: message.slice(0, 500) } });
    throw new HttpError(502, message);
  }
  await ref.update({ [`sync.${type}`]: { state: 'requested', at: Date.now() } });
  res.status(200).send({ ok: true });
});

// ---- moving through the wizard ----

/** The steps the user moves between by choice or confirmation. The others are set by the step's own function. */
export const setOnboardingStep = post(async (req, res) => {
  const { phoneNumberId, apiKey, step } = (req.body ?? {}) as Partial<SetOnboardingStepRequest>;
  if (!phoneNumberId || !apiKey || !step) throw new HttpError(400, 'phoneNumberId, apiKey and step are required');
  await authenticateKey(String(phoneNumberId), apiKey);
  const ref = numbers().doc(String(phoneNumberId));

  const next = await getFirestore().runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data() as PhoneNumberDoc;
    const current = doc.onboarding?.step;
    const allowed =
      (step === 'register' && current === 'not_on_app') ||
      (step === 'templates' && current === 'sync' && doc.sync?.contacts?.state === 'requested' && doc.sync?.history?.state === 'requested') ||
      (step === 'done' && current === 'templates');
    if (!allowed) throw new HttpError(409, `This number can't go from ${current ?? 'no step'} to ${step}.`);
    tx.update(ref, { onboarding: movedTo(doc.onboarding!, step) });
    return step;
  });
  res.status(200).send({ ok: true, step: next });
});

// ---- templates ----

const WABA_ID = /^\d{8,20}$/;

/**
 * Copies the approved templates of the user's previous Messaging account into this number's. It
 * first checks our token can read the source: if not (the user didn't share it, or it belongs to
 * their provider), the answer says so and the user is sent back to their provider.
 */
export const migrateTemplates = post(async (req, res) => {
  const { phoneNumberId, apiKey, sourceWabaId } = (req.body ?? {}) as Partial<MigrateTemplatesRequest>;
  if (!phoneNumberId || !apiKey || !WABA_ID.test(String(sourceWabaId ?? ''))) {
    throw new HttpError(400, 'phoneNumberId, apiKey and the previous Messaging account ID (digits only) are required');
  }
  const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const source = String(sourceWabaId);
  if (source === wabaId) throw new HttpError(400, 'That is this number\'s own Messaging account.');

  try {
    await verifyWabaAccess(source, accessToken);
  } catch {
    const body: MigrateTemplatesResponse = { ok: true, outcome: 'unreadable' };
    res.status(200).send(body);
    return;
  }

  let migrated = 0;
  const failed: { id: string; reason: string }[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await migrateTemplatesPage(wabaId, source, accessToken, page);
    migrated += result.migrated.length;
    for (const [id, reason] of Object.entries(result.failed)) failed.push({ id, reason });
    if (result.migrated.length + Object.keys(result.failed).length < 500) break;
  }
  await numbers().doc(String(phoneNumberId)).update({ 'onboarding.templateSourceWabaId': source });
  const body: MigrateTemplatesResponse = { ok: true, outcome: 'done', migrated, failed };
  res.status(200).send(body);
});

// Meta allows 100 template creations per hour per account.
const MAX_IMPORT = 100;

/** Creates the templates in a list the previous provider exported, one at a time, and says which failed. */
export const importTemplates = post(
  async (req, res) => {
    const { phoneNumberId, apiKey, templates } = (req.body ?? {}) as Partial<ImportTemplatesRequest>;
    if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId, apiKey and templates are required');
    const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
    const parsed = parseTemplateExport(templates);
    if (parsed.templates.length > MAX_IMPORT) {
      throw new HttpError(400, `Import up to ${MAX_IMPORT} templates at a time: Meta allows ${MAX_IMPORT} creations per hour per account.`);
    }

    let created = 0;
    const failed = [...parsed.rejected];
    for (const template of parsed.templates) {
      try {
        await createTemplate(wabaId, accessToken, template);
        created += 1;
      } catch (err) {
        failed.push({ name: template.name, language: template.language, reason: (err as Error).message.slice(0, 300) });
      }
    }
    const body: ImportTemplatesResponse = { ok: true, created, failed };
    res.status(200).send(body);
  },
  { timeoutSeconds: 300 },
);

// ---- test data for the user's own endpoint ----

// testRuns/{userId} holds the codes of the last send and when it went out. It has no Firestore
// rules, so no browser can read it: the codes are only ever checked here.
const TEST_GAP_MS = 30 * 1000;
const TEST_CODES_VALID_MS = 30 * 60 * 1000;

/** Posts one test webhook of each kind to the user's callback URL, each carrying its own new code. */
export const sendTestEvents = post(async (req, res) => {
  const userId = await requireAuth(req);
  const { overrideCallbackUrl } = (req.body ?? {}) as Partial<SendTestEventsRequest>;
  const url = String(overrideCallbackUrl ?? '');
  const check = await checkPublicUrl(url);
  if (!check.ok) throw new HttpError(400, check.error!);

  const ref = getFirestore().collection('testRuns').doc(userId);
  const codes = newCodes();
  const wait = await getFirestore().runTransaction(async (tx) => {
    const last = (await tx.get(ref)).data() as { sentAt?: number } | undefined;
    const elapsed = Date.now() - (last?.sentAt ?? 0);
    if (elapsed < TEST_GAP_MS) return Math.ceil((TEST_GAP_MS - elapsed) / 1000);
    tx.set(ref, { codes, sentAt: Date.now() });
    return 0;
  });
  if (wait > 0) {
    const body: SendTestEventsResponse = { ok: false, error: `You can send test data once every 30 seconds. Wait ${wait} seconds.`, retryAfter: wait };
    res.status(429).send(body);
    return;
  }

  const sent = await Promise.all(TEST_EVENT_TYPES.map((type) => sendTestEvent(url, type, codes[type])));
  const results = Object.fromEntries(TEST_EVENT_TYPES.map((type, i) => [type, sent[i]])) as SendTestEventsResponse['results'];
  const body: SendTestEventsResponse = { ok: true, results };
  res.status(200).send(body);
});

/** Says which of the codes the user typed match the last test send. The right codes are never returned. */
export const verifyTestCodes = post(async (req, res) => {
  const userId = await requireAuth(req);
  const { codes } = (req.body ?? {}) as Partial<VerifyTestCodesRequest>;
  const run = (await getFirestore().collection('testRuns').doc(userId).get()).data() as
    | { codes: Record<TestEventType, string>; sentAt: number }
    | undefined;
  if (!run || Date.now() - run.sentAt > TEST_CODES_VALID_MS) throw new HttpError(409, 'Send the test data first.');

  const correct = Object.fromEntries(
    TEST_EVENT_TYPES.map((type) => [type, String(codes?.[type] ?? '').trim().toUpperCase() === run.codes[type]]),
  ) as Record<TestEventType, boolean>;
  const body: VerifyTestCodesResponse = { ok: true, correct };
  res.status(200).send(body);
});
