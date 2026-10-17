import { requireAuth, HttpError } from './helpers/auth';
import { authenticateKey } from './accounts';
import { getPhoneNumberInfo, requestSmbAppData } from './helpers/graphApi';
import { checkPublicUrl, verifyEndpointChallenge } from './helpers/endpointCheck';
import { claimSync, moveStep, movedTo, readNumber, readTestRun, recordOverrideResult, reserveTestSend, setSyncState } from './helpers/model';
import { config } from './helpers/config';
import { logEvent } from './helpers/log';
import { post } from './helpers/http';
import { newCodes, sendTestEvent, TEST_EVENT_TYPES } from './helpers/testEvents';
import type {
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
// the functions here carry it through the rest: the contacts and history syncs, the steps the user
// confirms, and the test data they send to their own endpoint first.

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
    logEvent('sync request failed', { phoneNumberId, syncType: type, error: message.slice(0, 300) });
    await setSyncState(String(phoneNumberId), type, { state: 'failed', at: Date.now(), error: message.slice(0, 500) });
    throw new HttpError(502, message);
  }
  await setSyncState(String(phoneNumberId), type, { state: 'requested', at: Date.now() });
  logEvent('sync requested', { phoneNumberId, syncType: type });
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
