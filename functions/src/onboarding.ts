import { onRequest, type Request } from 'firebase-functions/v2/https';
import cors from 'cors';
import type { Response } from 'express';
import { HttpError, requireAuth } from './helpers/auth';
import { authenticateKey } from './accounts';
import {
  createTemplate,
  deregisterPhoneNumber,
  getPhoneNumberInfo,
  migrateTemplatesPage,
  requestSmbAppData,
  unsubscribeApp,
  verifyWabaAccess,
} from './helpers/graphApi';
import { checkPublicUrl, verifyEndpointChallenge } from './helpers/endpointCheck';
import {
  claimSync,
  markDeregistered,
  moveStep,
  movedTo,
  readNumber,
  readTestRun,
  recordOverrideResult,
  reserveTestSend,
  setSyncState,
  setTemplateSource,
} from './helpers/model';
import { config } from './helpers/config';
import { newCodes, sendTestEvent, TEST_EVENT_TYPES } from './helpers/testEvents';
import { parseTemplateExport } from './helpers/templateImport';
import type {
  DeregisterNumberRequest,
  DisconnectNumberRequest,
  DisconnectNumberResponse,
  ImportTemplatesResponse,
  MigrateTemplatesResponse,
  OnboardingStep,
  SendTestEventsRequest,
  SendTestEventsResponse,
  SetOnboardingStepRequest,
  StartSyncRequest,
  SyncType,
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

/**
 * Called once the callback URL is subscribed: finds out from Meta whether the number is also on the
 * WhatsApp Business app, and moves the wizard to the next step. The coexistence event is trusted for
 * the path; `is_on_biz_app` decides it for the plain event.
 */
export async function advanceAfterOverride(phoneNumberId: string, accessToken: string): Promise<{ step: OnboardingStep; isOnBizApp?: boolean }> {
  const doc = (await readNumber(phoneNumberId))!;
  const info = await getPhoneNumberInfo(phoneNumberId, accessToken);
  const coexistence = doc.onboarding.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || info.isOnBizApp === true;
  const step: OnboardingStep = coexistence ? 'sync' : 'not_on_app';
  await recordOverrideResult(phoneNumberId, {
    onboarding: movedTo(doc.onboarding, step),
    isOnBizApp: info.isOnBizApp ?? false,
    metaStatus: info.status,
    platformType: info.platformType,
    startSync: coexistence,
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
  // The record now shows an API-only number that is not connected, so effectiveStep sends the user
  // to the wizard's register step.
  await markDeregistered(String(phoneNumberId));
  res.status(200).send({ ok: true });
});

/**
 * What leaving Watobot does on Meta's side, for one number: our app stops receiving its webhooks
 * and, if asked and it is API-only, the number comes off the Cloud API (so another provider can
 * take it). A number that is also on the Business app is only unsubscribed: Meta can't de-register
 * it, and the way off is the app's own Disconnect, which the answer tells the caller to point out.
 * The records are deleted by the caller afterwards.
 */
export const disconnectNumber = post(async (req, res) => {
  const { phoneNumberId, apiKey, deregister } = (req.body ?? {}) as Partial<DisconnectNumberRequest>;
  if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId and apiKey are required');
  const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const info = await getPhoneNumberInfo(String(phoneNumberId), accessToken);
  const coexistence = info.isOnBizApp === true;

  await unsubscribeApp(wabaId, accessToken);
  let deregistered = false;
  if (deregister && !coexistence) {
    await deregisterPhoneNumber(String(phoneNumberId), accessToken);
    deregistered = true;
  }
  const body: DisconnectNumberResponse = { ok: true, coexistence, deregistered };
  res.status(200).send(body);
});

// ---- the contacts and history syncs ----

const META_SYNC_TYPE = { contacts: 'smb_app_state_sync', history: 'history' } as const;
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
  const type: SyncType = syncType;

  // Claim the request first, so two clicks cannot both send it.
  const claimed = await claimSync(String(phoneNumberId), type);
  if (claimed !== 'ok') {
    const refusals = {
      not_at_step: 'This number is not at the sync step.',
      already_requested: `The ${type} sync was already requested. Meta allows it only once.`,
      in_flight: `The ${type} sync is being requested.`,
      contacts_first: 'Request the contacts sync first.',
    };
    throw new HttpError(409, refusals[claimed]);
  }

  try {
    await requestSmbAppData(String(phoneNumberId), accessToken, META_SYNC_TYPE[type]);
  } catch (err) {
    const message = (err as Error).message;
    await setSyncState(String(phoneNumberId), type, { state: 'failed', at: Date.now(), error: message.slice(0, 500) });
    throw new HttpError(502, message);
  }
  await setSyncState(String(phoneNumberId), type, { state: 'requested', at: Date.now() });
  res.status(200).send({ ok: true });
});

// ---- moving through the wizard ----

/** The steps the user moves between by choice or confirmation. The others are set by the step's own function. */
export const setOnboardingStep = post(async (req, res) => {
  const { phoneNumberId, apiKey, step } = (req.body ?? {}) as Partial<SetOnboardingStepRequest>;
  if (!phoneNumberId || !apiKey || !step) throw new HttpError(400, 'phoneNumberId, apiKey and step are required');
  await authenticateKey(String(phoneNumberId), apiKey);

  let current: OnboardingStep | undefined;
  const next = await moveStep(String(phoneNumberId), (doc) => {
    current = doc.onboarding.step;
    const allowed =
      (step === 'register' && current === 'not_on_app') ||
      (step === 'templates' && current === 'sync' && doc.sync?.contacts?.state === 'requested' && doc.sync?.history?.state === 'requested') ||
      (step === 'done' && current === 'templates');
    return allowed ? step : null;
  });
  if (!next) throw new HttpError(409, `This number can't go from ${current ?? 'no step'} to ${step}.`);
  res.status(200).send({ ok: true, step: next });
});

// ---- templates ----

const WABA_ID = /^\d{8,20}$/;

/**
 * Copies the approved templates of the user's previous Messaging account into this number's. It
 * first checks our token can read the source: if not (the user didn't share it, or it belongs to
 * their provider), the answer says so and the user is sent back to their provider.
 * Served by the templates function: POST templates/<phoneNumberId>/migrate.
 */
export async function migrateTemplatesFor(phoneNumberId: string, apiKey: string, sourceWabaId: unknown): Promise<MigrateTemplatesResponse> {
  if (!WABA_ID.test(String(sourceWabaId ?? ''))) throw new HttpError(400, 'sourceWabaId (the previous Messaging account ID, digits only) is required');
  const { wabaId, accessToken } = await authenticateKey(phoneNumberId, apiKey);
  const source = String(sourceWabaId);
  if (source === wabaId) throw new HttpError(400, 'That is this number\'s own Messaging account.');

  try {
    await verifyWabaAccess(source, accessToken);
  } catch {
    return { ok: true, outcome: 'unreadable' };
  }

  let migrated = 0;
  const failed: { id: string; reason: string }[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await migrateTemplatesPage(wabaId, source, accessToken, page);
    migrated += result.migrated.length;
    for (const [id, reason] of Object.entries(result.failed)) failed.push({ id, reason });
    if (result.migrated.length + Object.keys(result.failed).length < 500) break;
  }
  await setTemplateSource(phoneNumberId, source);
  return { ok: true, outcome: 'done', migrated, failed };
}

// Meta allows 100 template creations per hour per account.
const MAX_IMPORT = 100;

/**
 * Creates the templates in a list the previous provider exported, one at a time, and says which
 * failed. Served by the templates function: POST templates/<phoneNumberId>/import.
 */
export async function importTemplatesFor(phoneNumberId: string, apiKey: string, templates: unknown): Promise<ImportTemplatesResponse> {
  const { wabaId, accessToken } = await authenticateKey(phoneNumberId, apiKey);
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
  return { ok: true, created, failed };
}

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

  const codes = newCodes();
  const wait = await reserveTestSend(userId, codes, TEST_GAP_MS);
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
  const run = await readTestRun(userId);
  if (!run || Date.now() - run.sentAt > TEST_CODES_VALID_MS) throw new HttpError(409, 'Send the test data first.');

  const correct = Object.fromEntries(
    TEST_EVENT_TYPES.map((type) => [type, String(codes?.[type] ?? '').trim().toUpperCase() === run.codes[type]]),
  ) as Record<TestEventType, boolean>;
  const body: VerifyTestCodesResponse = { ok: true, correct };
  res.status(200).send(body);
});
