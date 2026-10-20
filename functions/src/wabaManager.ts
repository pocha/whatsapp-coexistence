import { createHash } from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import { config } from './helpers/config';
import { createTemplate, deregisterPhoneNumber, getDisplayPhoneNumber, getPhoneNumberInfo, graphApiBase, graphGet, migrateTemplatesPage, parseTemplateExport, registerPhoneNumber, requestDisplayName, subscribeApp, unsubscribeApp, verifyWabaAccess } from './helpers/graphApi';
import { HttpError, failedRequest, logEvent, newApp, type Handler } from './helpers/http';
import { progressOf, relayLimits } from './helpers/onboarding';
import { issuesFromRefusal, refreshHealth, templateGateFromRefusal } from './helpers/health';
import { sendDecision, templateKey } from './helpers/sendGate';
import { applyEffects, type Effect } from './helpers/rules';
import { limitsView, UNITS, type Limits, type RateState } from './helpers/rateLimiter';
import { verifyEndpointChallenge } from './helpers/callBackUrlCheck';
import type {
  DeregisterNumberRequest,
  DisconnectNumberRequest,
  DisconnectNumberResponse,
  ImportTemplatesResponse,
  MigrateTemplatesResponse,
  OnboardingResponse,
  PhoneNumberDoc,
  RegisterNumberRequest,
  SetDisplayNameRequest,
  SetWebhookRequest,
} from './helpers/types';
import { authenticateKey } from './accounts';
import { advanceAfterOverride } from './onboarding';
import {
  markDeregistered,
  markRegistered,
  movedTo,
  noteOnboardingError,
  readNumber,
  recordRelayCall,
  reserveTemplateSend,
  setCallback,
  setDisplayPhoneNumber,
  updateGates,
  addNotification,
  setTemplateSource,
} from './helpers/model';

// What a customer does with a number through its Watobot API key: set where incoming messages go
// (setWebhook), register it, de-register it or disconnect it from Watobot, send messages
// (relayMessage) and manage message templates (templates). Each one finds the number, checks the
// key, decrypts the stored Meta token in memory for the request, and calls Meta with it. The
// wizard that onboards a number is in onboarding.ts.


/** Saves how the number is shown (best-effort; the sidebar falls back to the phone number ID). */
async function rememberDisplayNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  try {
    const displayPhoneNumber = await getDisplayPhoneNumber(phoneNumberId, accessToken);
    if (displayPhoneNumber) {
      await setDisplayPhoneNumber(phoneNumberId, displayPhoneNumber);
    }
  } catch {
    // The sidebar falls back to the phone number ID.
  }
}

// ---- setWebhook ----

// Points a number's WABA at the business's own incoming-message endpoint.
//
// No sign-in: the Watobot API key is the credential. It is checked against the
// account first, so only the key's holder can make us fetch the supplied URL (an
// open version of that would be an SSRF / scanning target). The stored Meta token
// is decrypted in memory for this one request.
//
// On success the new URL is recorded on the number's record, so the Dashboard can show
// it. The browser never writes it.
export const setWebhook: Handler = async (req, res) => {
  const { phoneNumberId, apiKey, overrideCallbackUrl, noCallback } = (req.body ?? {}) as Partial<SetWebhookRequest>;
  if (!phoneNumberId || !apiKey || (!overrideCallbackUrl && noCallback !== true)) {
    res.status(400).send({ ok: false, error: 'phoneNumberId, apiKey and either overrideCallbackUrl or noCallback are required' });
    return;
  }

  try {
    const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);

    try {
      // With a URL it must answer Meta's handshake first. With none, the app is subscribed with no
      // override and incoming events go to Watobot's own webhook, which discards them.
      const url = noCallback === true ? undefined : overrideCallbackUrl;
      if (url) {
        const check = await verifyEndpointChallenge(url, config.webhookVerifyToken);
        if (!check.ok) throw new HttpError(400, check.error!);
      }

      await subscribeApp(wabaId, accessToken, url, config.webhookVerifyToken);
      await setCallback(String(phoneNumberId), url);
      await rememberDisplayNumber(String(phoneNumberId), accessToken);

      // A number in the onboarding wizard moves on from here; a finished one just gets its new URL.
      const doc = (await readNumber(String(phoneNumberId)))!;
      if (doc.onboarding.step === 'override') {
        const moved = await advanceAfterOverride(String(phoneNumberId), accessToken);
        const body: OnboardingResponse = { ok: true, ...moved, ...progressOf((await readNumber(String(phoneNumberId)))!) };
        res.status(200).send(body);
        return;
      }
      res.status(200).send({ ok: true });
    } catch (err) {
      logEvent('override subscription failed', { phoneNumberId, error: (err as Error).message });
      await noteOnboardingError(String(phoneNumberId), 'override', (err as Error).message);
      throw err;
    }
  } catch (err) {
    const status = failedRequest(req, err);
    res.status(status).send({ ok: false, error: (err as Error).message });
  }
};

// ---- setDisplayName ----

// Asks Meta to review a new display name. Only one change may wait for review at a time: asking again
// while one is pending (or while Meta's answer can't be read) is refused here, so nobody ends up
// resubmitting while the first is in review. Needs the Watobot API key, like the other number calls.
export const setDisplayName: Handler = async (req, res) => {
  const { phoneNumberId, apiKey, displayName } = (req.body ?? {}) as Partial<SetDisplayNameRequest>;
  const name = String(displayName ?? '').trim();
  if (!phoneNumberId || !apiKey || name.length < 3) throw new HttpError(400, 'phoneNumberId, apiKey and a display name of at least 3 characters are required');
  const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);

  let current: Record<string, unknown>;
  try {
    current = await graphGet(`/${encodeURIComponent(String(phoneNumberId))}?fields=new_display_name,new_name_status`, accessToken);
  } catch (err) {
    throw new HttpError(502, `Could not check whether a display name is already in review (${(err as Error).message.slice(0, 160)}), so nothing was submitted.`);
  }
  if (/PENDING/i.test(String(current.new_name_status ?? ''))) {
    throw new HttpError(409, `A display name change ("${current.new_display_name ?? 'unknown'}") is already in review. Wait for Meta's decision before asking again.`);
  }

  await requestDisplayName(String(phoneNumberId), accessToken, name);
  logEvent('display name requested', { phoneNumberId });
  // The new request shows in the stored display name state straight away.
  await refreshHealth({ phoneNumberId: String(phoneNumberId), wabaId, accessToken }).catch(() => undefined);
  res.status(200).send({ ok: true });
};

// ---- registerNumber ----

// Registers a number for Cloud API use after Embedded Signup, which a brand-new (not
// coexistence) number needs before it can send or receive. Same auth as setWebhook: the
// Watobot API key, no sign-in. Meta's error is returned as is, so a failure says why.
// Meta's register call can be slow, so registerPhoneNumber waits up to 45 s of the function's minute.
export const registerNumber: Handler = async (req, res) => {
  const { phoneNumberId, apiKey, pin } = (req.body ?? {}) as Partial<RegisterNumberRequest>;
  if (!phoneNumberId || !apiKey || !/^\d{6}$/.test(String(pin ?? ''))) {
    res.status(400).send({ ok: false, error: 'phoneNumberId, apiKey and a 6-digit pin are required' });
    return;
  }

  try {
    const { accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
    try {
      // A number that is also on the WhatsApp Business app is already registered. Registering it
      // for the API alone would take it off the app, so it is refused.
      const info = await getPhoneNumberInfo(String(phoneNumberId), accessToken);
      if (info.isOnBizApp === true) {
        throw new HttpError(409, 'This number is on the WhatsApp Business app, which already registers it. Registering it for the API alone would take it off the app, so it is not done.');
      }
      await registerPhoneNumber(String(phoneNumberId), accessToken, String(pin));
    } catch (err) {
      await noteOnboardingError(String(phoneNumberId), 'register', (err as Error).message);
      throw err;
    }
    await rememberDisplayNumber(String(phoneNumberId), accessToken);

    // The API-only path of the wizard continues with templates once the number is registered, whether
    // the user chose API-only first (register) or the call came straight from the choice screen.
    const doc = (await readNumber(String(phoneNumberId)))!;
    const atRegister = doc.onboarding.step === 'register' || doc.onboarding.step === 'not_on_app';
    await markRegistered(String(phoneNumberId), atRegister ? movedTo(doc.onboarding, 'templates') : undefined);
    logEvent('number registered', { phoneNumberId });
    const body: OnboardingResponse = { ok: true, ...progressOf((await readNumber(String(phoneNumberId)))!) };
    res.status(200).send(body);
  } catch (err) {
    const status = failedRequest(req, err);
    res.status(status).send({ ok: false, error: (err as Error).message });
  }
};

// ---- leaving the API ----

/**
 * Takes a standard (API-only) number off the Cloud API, so another provider can onboard it. A
 * number that is also on the WhatsApp Business app can't be deregistered: the way off is to
 * disconnect in the app, so that is what the answer says.
 */
export const deregisterNumber: Handler = async (req, res) => {
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
  logEvent('number deregistered', { phoneNumberId });
  res.status(200).send({ ok: true });
};

/**
 * What leaving Watobot does on Meta's side, for one number: our app stops receiving its webhooks
 * and, if asked and it is API-only, the number comes off the Cloud API (so another provider can
 * take it). A number that is also on the Business app is only unsubscribed: Meta can't de-register
 * it, and the way off is the app's own Disconnect, which the answer tells the caller to point out.
 * The records are deleted by the caller afterwards.
 */
export const disconnectNumber: Handler = async (req, res) => {
  const { phoneNumberId, apiKey, deregister } = (req.body ?? {}) as Partial<DisconnectNumberRequest>;
  if (!phoneNumberId || !apiKey) throw new HttpError(400, 'phoneNumberId and apiKey are required');
  const { wabaId, accessToken } = await authenticateKey(String(phoneNumberId), apiKey);
  const info = await getPhoneNumberInfo(String(phoneNumberId), accessToken);
  const coexistence = info.isOnBizApp === true;

  await unsubscribeApp(wabaId, accessToken);
  logEvent('number disconnected', { phoneNumberId, wabaId, coexistence, deregister });
  let deregistered = false;
  if (deregister && !coexistence) {
    await deregisterPhoneNumber(String(phoneNumberId), accessToken);
    deregistered = true;
  }
  const body: DisconnectNumberResponse = { ok: true, coexistence, deregistered };
  res.status(200).send(body);
};

// ---- relayMessage ----

export function dailyKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function monthlyKey(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}


/** What is left in each window and when it resets, as headers on a template send, so a sender can pace itself. */
function setRateHeaders(res: express.Response, state: RateState, earned: Limits, caps: Limits, now: number) {
  const windows = limitsView(state, earned, caps, now);
  for (const unit of UNITS) {
    const name = unit[0].toUpperCase() + unit.slice(1);
    res.set(`X-RateLimit-Remaining-${name}`, String(windows[unit].remaining));
    res.set(`X-RateLimit-Reset-${name}`, String(Math.ceil(windows[unit].resetsAt / 1000)));
  }
}

// The functions that serve a customer's numbers are Express apps, each one deployed function with its own
// timeout (the default minute unless noted):
//   numbers        /numbers/<phone number ID>/...   the relay is registered here; numbersApi.ts adds the rest
//   templates      /templates/<phone number ID>/... list, create, edit, delete
//   templatesBulk  /templatesBulk/<id>/...          migrate and import: they go through many templates, so 300 s
export const numbersApp = newApp();

// The actual product: a proxy in front of Meta's own /{phone-number-id}/messages
// endpoint. The caller authenticates with their Watobot API key, not a Meta
// token. We find their number, check the key, decrypt the Meta token we hold for
// it (in memory, for this request only) and forward the message body untouched.
//
// Because every send passes through here, usage is counted reliably, and rate
// limiting and per-recipient serialization (upcoming, see README) can be added
// in this one place.
numbersApp.post('/:phoneNumberId/messages', async (req, res) => {
  const { phoneNumberId } = req.params;
  const authHeader = req.headers.authorization;
  const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }

  let accessToken: string;
  let number: PhoneNumberDoc;
  try {
    ({ accessToken, number } = await authenticateKey(phoneNumberId, key));
  } catch (err) {
    res.status(failedRequest(req, err)).send({ error: (err as Error).message });
    return;
  }

  // What is stored about the number decides first: a disabled number sends nothing, a blocked one no template
  // messages, and a template Meta paused or disabled is not sent. Then the rate limits.
  const decision = sendDecision(number, req.body, Date.now());
  if (!decision.allow) {
    logEvent('send refused', { phoneNumberId, status: decision.status });
    if (decision.retryAfterSeconds) res.set('Retry-After', String(decision.retryAfterSeconds));
    res.status(decision.httpStatus).send({ error: decision.error, status: decision.status, issues: decision.issues, retryAfterSeconds: decision.retryAfterSeconds });
    return;
  }

  // Only template messages are limited; free-form replies go straight through.
  if (req.body?.type === 'template') {
    const { verdict, caps, now } = await reserveTemplateSend(phoneNumberId);
    if ('state' in verdict) setRateHeaders(res, verdict.state, verdict.earned, caps, now);
    if (!verdict.allowed && 'unit' in verdict) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      logEvent('template send limited', { phoneNumberId, window: verdict.unit, limit: verdict.limit });
      res.status(429).send({
        error: `Rate limit reached: ${verdict.current} template messages this ${verdict.unit} (limit ${verdict.limit}). Try again in ${verdict.retryAfterSeconds}s.`,
        window: verdict.unit,
        limit: verdict.limit,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }
  }

  const metaRes = await fetch(`${graphApiBase()}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(10000),
  });
  const body = await metaRes.json();

  const now = new Date();
  await recordRelayCall(phoneNumberId, {
    at: now.getTime(),
    ok: metaRes.ok,
    statusCode: metaRes.status,
    usageKeys: { daily: dailyKey(now), weekly: isoWeekKey(now), monthly: monthlyKey(now) },
  });

  if (!metaRes.ok) {
    logEvent('Meta refused a send', { phoneNumberId, status: metaRes.status, metaError: body?.error });
    // A refusal that says the account can't send, or that a template is paused, is remembered, so the next sends are not even tried.
    await rememberRefusal(phoneNumberId, body?.error, templateKey(req.body)).catch(() => undefined);
  }
  res.status(metaRes.status).send(body);
});

// Where the number stands against its template-send limits, so a sender (or an AI tool) can pace
// itself: per window what went through, what is left and when it resets.
/** What a refused send tells us about the number or the template, as gates, and a line in the notifications. */
async function rememberRefusal(phoneNumberId: string, error: { code?: number; message?: string } | undefined, key: string | undefined): Promise<void> {
  const at = Date.now();
  const issues = issuesFromRefusal(error, at);
  const template = templateGateFromRefusal(error, key, at);
  const effects: Effect[] = [...issues.map(({ scope, why, issue }) => ({ kind: 'set' as const, scope, why, issue })), ...(template ? [{ kind: 'template' as const, key: template.key, gate: template.gate }] : [])];
  if (!effects.length) return;
  await updateGates(phoneNumberId, (doc) => applyEffects(doc, effects, at));
  const id = createHash('sha1').update(`send|${phoneNumberId}|${error?.code}|${Math.floor(at / 60000)}`).digest('hex');
  await addNotification(phoneNumberId, id, {
    eventAt: at,
    receivedAt: at,
    field: 'send',
    event: String(error?.code),
    title: issues[0]?.issue.title ?? `Template ${template?.gate.status.toLowerCase()}`,
    message: issues[0]?.issue.message ?? `Meta refused a send of "${key}": ${error?.message ?? 'the template is not available'}.`,
    severity: 'warning',
  });
}

numbersApp.get('/:phoneNumberId/limits', async (req, res) => {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ ok: false, error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    await authenticateKey(req.params.phoneNumberId, key);
    res.status(200).send(relayLimits((await readNumber(req.params.phoneNumberId))!, Date.now()));
  } catch (err) {
    res.status(failedRequest(req, err)).send({ ok: false, error: (err as Error).message });
  }
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
  logEvent('templates migrated', { phoneNumberId, source, migrated, failed: failed.length });
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
  logEvent('templates imported', { phoneNumberId, created, failed: failed.length });
  return { ok: true, created, failed };
}

const templatesApp = newApp();
const templatesBulkApp = newApp();

// Message template list / create / edit / delete for a number's WABA, using the stored
// Meta token. Same auth as the relay: `Authorization: Bearer <Watobot API key>`.
// Meta's response and status are returned unchanged.
async function forward(
  req: express.Request,
  res: express.Response,
  method: 'GET' | 'POST' | 'DELETE',
  query: string,
  body?: unknown,
  templateId?: string,
) {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    const { wabaId, accessToken } = await authenticateKey(req.params.phoneNumberId, key);
    // Editing posts to the template's own id; everything else works on the WABA's collection.
    const target = templateId ?? `${wabaId}/message_templates`;
    const metaRes = await fetch(`${graphApiBase()}/${target}${query}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    res.status(metaRes.status).send(await metaRes.json().catch(() => ({})));
  } catch (err) {
    res.status(failedRequest(req, err)).send({ error: (err as Error).message });
  }
}

templatesApp.get('/:phoneNumberId', (req, res) =>
  forward(req, res, 'GET', '?fields=id,name,status,category,language,components&limit=100'),
);
templatesApp.post('/:phoneNumberId', (req, res) => forward(req, res, 'POST', '', req.body));
// Bring templates across from another Messaging account, or from a list exported elsewhere.
async function withKeyAnswer(req: express.Request, res: express.Response, run: (key: string) => Promise<object>) {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!key) {
    res.status(401).send({ ok: false, error: 'Missing Authorization: Bearer <your Watobot API key>' });
    return;
  }
  try {
    res.status(200).send(await run(key));
  } catch (err) {
    res.status(failedRequest(req, err)).send({ ok: false, error: (err as Error).message });
  }
}
templatesBulkApp.post('/:phoneNumberId/migrate', (req, res) =>
  withKeyAnswer(req, res, (key) => migrateTemplatesFor(req.params.phoneNumberId, key, req.body?.sourceWabaId)),
);
templatesBulkApp.post('/:phoneNumberId/import', (req, res) =>
  withKeyAnswer(req, res, (key) => importTemplatesFor(req.params.phoneNumberId, key, req.body?.templates)),
);
templatesApp.post('/:phoneNumberId/:templateId', (req, res) => {
  if (!/^\d+$/.test(req.params.templateId)) {
    res.status(400).send({ error: 'The template id is the number from the list response.' });
    return;
  }
  forward(req, res, 'POST', '', req.body, req.params.templateId);
});
templatesApp.delete('/:phoneNumberId', (req, res) =>
  forward(req, res, 'DELETE', `?name=${encodeURIComponent(String(req.query.name ?? ''))}`),
);

export const templates = onRequest(templatesApp);
// Migrating and importing go through many templates (Meta allows 100 creations an hour), so they get longer.
export const templatesBulk = onRequest({ timeoutSeconds: 300 }, templatesBulkApp);
