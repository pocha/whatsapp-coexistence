import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { META_APP_ID, META_CONFIG_ID } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { isValidApiKey } from '/assets/api-key.js';
import { callAsUser, keyMatchesAccount } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import { wireTestEvents } from '/assets/test-events.js';
import type {
  ExchangeCodeRequest,
  ImportTemplatesRequest,
  ImportTemplatesResponse,
  MigrateTemplatesRequest,
  MigrateTemplatesResponse,
  OnboardingResponse,
  OnboardingStep,
  PhoneNumberDoc,
  RegisterNumberRequest,
  SetOnboardingStepRequest,
  SetWebhookRequest,
  SignupEvent,
  StartSyncRequest,
  SyncStatus,
  SyncType,
  UserDoc,
} from '../../../functions/src/helpers/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// The onboarding wizard. Before Meta's popup opens it checks what the user will need afterwards
// (a callback URL that handles the data Meta sends, the Business app, where their templates are).
// Once the popup finishes the number has a record, which keeps the step the wizard is at, so
// "?id=<phone number ID>" picks it up again after a reload or a failure. Until then nothing is
// stored anywhere: the URL and what the user entered live in this page only.

const params = new URLSearchParams(location.search);
const resumeId = params.get('id');

const keyInput = el<HTMLInputElement>('key-input');
const status = el('onboarding-status');
const lastError = el('last-error');
const VIEWS = ['view-start', 'view-checks', 'view-override', 'view-not-on-app', 'view-register', 'view-sync', 'view-templates'];

function show(view: string | null) {
  for (const id of VIEWS) el(id).classList.toggle('hidden', id !== view);
}

function fail(message: string | undefined) {
  lastError.textContent = message ?? '';
  lastError.classList.toggle('hidden', !message);
}

let keyVerified = false;
let sdkReady = false;

// What the user entered in the checks, kept in this page for the later steps.
let callbackUrl = '';
let urlVerified = false;
let testCodesOk = false;
let templateChoice: 'none' | 'own' | 'provider' | null = null;
let templateList: unknown = null;
let templateCount = 0;

// Where the popup got to.
let signupCode: string | null = null;
let signupEvent: SignupEvent | null = null;
let wabaId: string | null = null;
let phoneNumberId: string | null = resumeId;
let exchanging = false;

const apiKey = () => keyInput.value.trim();

/** POSTs to a Function with the Watobot API key as the credential (no sign-in needed). */
async function withKey<T extends { ok: boolean; error?: string }>(fn: string, body: object): Promise<T> {
  const res = await fetch(`${functionsBase()}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumberId, apiKey: apiKey(), ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadNumber(): Promise<PhoneNumberDoc | undefined> {
  return (await getDoc(doc(db, 'phoneNumbers', phoneNumberId!))).data() as PhoneNumberDoc | undefined;
}

// --- The key ---------------------------------------------------------------------------------

async function checkKey() {
  keyVerified = false;
  if (!apiKey()) {
    status.textContent = 'Enter your API key to continue.';
  } else if (!isValidApiKey(apiKey())) {
    status.textContent = 'An API key is 64 characters of 0-9 and a-f.';
  } else if (await keyMatchesAccount(auth.currentUser!.uid, apiKey())) {
    keyVerified = true;
    status.textContent = '';
  } else {
    status.textContent = 'That is not the key for this account.';
  }
  el<HTMLButtonElement>('start-btn').disabled = !keyVerified;
  refreshGate();
}
keyInput.addEventListener('input', checkKey);

// --- Step 1: the checks ----------------------------------------------------------------------

const cbUrl = el<HTMLInputElement>('cb-url');
const cbStatus = el('cb-status');
const metaBtn = el<HTMLButtonElement>('meta-btn');

wireTestEvents(
  () => cbUrl.value,
  (ok) => {
    testCodesOk = ok;
    refreshGate();
  },
);

cbUrl.addEventListener('input', () => {
  urlVerified = false;
  cbStatus.textContent = '';
  refreshGate();
});

el('cb-verify').addEventListener('click', async () => {
  const url = cbUrl.value.trim();
  cbStatus.textContent = 'Checking…';
  try {
    await callAsUser(`${functionsBase()}/checkCallbackUrl`, { overrideCallbackUrl: url });
    urlVerified = true;
    callbackUrl = url;
    cbStatus.textContent = 'Your URL answered Meta\'s handshake.';
  } catch (err) {
    urlVerified = false;
    cbStatus.textContent = errorMessage(err);
  }
  refreshGate();
});

const tplRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="tpl"]'));
const tplSource = el<HTMLInputElement>('tpl-source');
const tplJson = el<HTMLTextAreaElement>('tpl-json');

const ID_RE = /^\d{8,20}$/;

/** How many templates a pasted export holds (Meta's whole response, or just its list). */
function countTemplates(parsed: unknown): number {
  const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown })?.data;
  return Array.isArray(list) ? list.length : 0;
}

function readTemplateChoice() {
  templateChoice = (tplRadios.find((r) => r.checked)?.value as typeof templateChoice) ?? null;
  el('tpl-own').classList.toggle('hidden', templateChoice !== 'own');
  el('tpl-provider').classList.toggle('hidden', templateChoice !== 'provider');
}
for (const r of tplRadios) r.addEventListener('change', () => (readTemplateChoice(), refreshGate()));
tplSource.addEventListener('input', refreshGate);
tplJson.addEventListener('input', () => {
  templateList = null;
  templateCount = 0;
  const text = tplJson.value.trim();
  const out = el('tpl-json-status');
  if (!text) {
    out.textContent = '';
  } else {
    try {
      templateList = JSON.parse(text);
      templateCount = countTemplates(templateList);
      out.textContent = templateCount ? `Found ${templateCount} templates.` : 'No templates found in that. Paste the whole response.';
    } catch {
      out.textContent = 'That is not valid JSON.';
    }
  }
  refreshGate();
});

/** What is still missing before the Meta popup can open. */
function missing(): string[] {
  const gaps: string[] = [];
  if (!keyVerified) gaps.push('your API key');
  if (!urlVerified) gaps.push('a verified callback URL');
  if (!el<HTMLInputElement>('cb-confirm').checked) gaps.push('the confirmation that your endpoint stores the data');
  if (!testCodesOk) gaps.push('the four test codes');
  if (!el<HTMLInputElement>('app-confirm').checked) gaps.push('the Business app confirmation');
  if (templateChoice === null) gaps.push('where your templates are');
  else if (templateChoice === 'own' && !ID_RE.test(tplSource.value.trim())) gaps.push('your previous Messaging account ID');
  else if (templateChoice === 'provider' && !templateCount) gaps.push('your provider\'s template list');
  return gaps;
}

function refreshGate() {
  const gaps = missing();
  metaBtn.disabled = gaps.length > 0 || !sdkReady;
  el('meta-hint').textContent = gaps.length ? `Still needed: ${gaps.join(', ')}.` : sdkReady ? 'Ready.' : 'Loading Meta\'s sign-up…';
}
for (const id of ['cb-confirm', 'app-confirm']) el(id).addEventListener('change', refreshGate);

el('start-btn').addEventListener('click', () => {
  show('view-checks');
  status.textContent = '';
  refreshGate();
});

// --- Meta's popup ----------------------------------------------------------------------------

function initEmbeddedSignup() {
  window.fbAsyncInit = function () {
    FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: 'v26.0' });
    sdkReady = true;
    refreshGate();
  };
  const script = document.createElement('script');
  script.src = 'https://connect.facebook.net/en_US/sdk.js';
  script.async = true;
  document.body.appendChild(script);

  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        signupEvent = data.event;
        wabaId = data.data.waba_id;
        phoneNumberId = data.data.phone_number_id;
        status.textContent = 'Signup finished, waiting for the code…';
        maybeFinish();
      } else if (data.event === 'CANCEL' || data.event === 'ERROR') {
        // Nothing was set up on our side, so there is nothing to clean up: the user starts again.
        const detail = data.data?.error_message ?? data.data?.current_step;
        fail(`Meta's signup did not finish${detail ? ` (${detail})` : ''}. See "If Meta's popup shows an error" above, then continue to Meta again.`);
      }
    } catch {
      // Not a JSON message we care about.
    }
  });

  metaBtn.addEventListener('click', () => {
    fail(undefined);
    FB.login(
      (response) => {
        if (response.authResponse?.code) {
          signupCode = response.authResponse.code;
          maybeFinish();
        } else {
          status.textContent = 'Login cancelled or failed.';
        }
      },
      {
        config_id: META_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        // whatsapp_business_app_onboarding makes the popup offer coexistence for a
        // number already on the WhatsApp Business app, not only "add a new number".
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
      },
    );
  });
}

// Both halves of Embedded Signup must arrive: the code (from FB.login's callback)
// and the ids and event (from a window message).
async function maybeFinish() {
  if (exchanging || !(signupCode && wabaId && phoneNumberId && signupEvent)) return;
  exchanging = true;
  status.textContent = 'Connecting your number…';
  try {
    await callAsUser(`${functionsBase()}/exchangeCode`, {
      code: signupCode,
      wabaId,
      phoneNumberId,
      apiKey: apiKey(),
      event: signupEvent,
    } satisfies ExchangeCodeRequest);
  } catch (err) {
    // The code is spent, so the popup has to run again.
    status.textContent = '';
    fail(`Could not connect the number: ${errorMessage(err)}`);
    exchanging = false;
    signupCode = null;
    return;
  }
  await connectOverride(callbackUrl);
}

// --- The callback URL ------------------------------------------------------------------------

/** Subscribes the user's URL (and, for a number in the wizard, finds the next step). */
async function connectOverride(url: string) {
  status.textContent = 'Pointing Meta at your URL…';
  fail(undefined);
  try {
    const res = await withKey<OnboardingResponse>('setWebhook', { overrideCallbackUrl: url } satisfies Partial<SetWebhookRequest>);
    status.textContent = '';
    await showStep(res.step ?? 'done');
  } catch (err) {
    status.textContent = '';
    fail(`Could not connect your URL: ${errorMessage(err)}`);
    el<HTMLInputElement>('ov-url').value = url;
    show('view-override');
  }
}

el('ov-btn').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('ov-btn');
  button.disabled = true;
  await connectOverride(el<HTMLInputElement>('ov-url').value.trim());
  button.disabled = false;
});

// --- The steps after the popup ---------------------------------------------------------------

async function showStep(step: OnboardingStep) {
  fail(undefined);
  fillSidebar(auth.currentUser!.uid, phoneNumberId);
  switch (step) {
    case 'override':
      el<HTMLInputElement>('ov-url').value ||= callbackUrl;
      return show('view-override');
    case 'not_on_app':
      return show('view-not-on-app');
    case 'register':
      show('view-register');
      return surfaceSavedError();
    case 'sync':
      await renderSync();
      return show('view-sync');
    case 'templates':
      await renderTemplates();
      return show('view-templates');
    case 'done':
      location.href = `/dashboard/waba/?id=${encodeURIComponent(phoneNumberId!)}`;
  }
}

/** The failure the server kept on the number, shown again after a reload. */
async function surfaceSavedError() {
  const saved = (await loadNumber())?.onboarding?.error;
  if (saved) fail(saved);
}

async function moveTo(step: SetOnboardingStepRequest['step']) {
  const res = await withKey<OnboardingResponse>('setOnboardingStep', { step });
  await showStep(res.step ?? step);
}

el('api-only-btn').addEventListener('click', async () => {
  try {
    await moveTo('register');
  } catch (err) {
    fail(errorMessage(err));
  }
});

// Register (API only)
el('register-btn').addEventListener('click', async () => {
  const pin = el<HTMLInputElement>('pin-input').value.trim();
  const out = el('register-status');
  if (!/^\d{6}$/.test(pin)) {
    out.textContent = 'The PIN is 6 digits.';
    return;
  }
  el<HTMLButtonElement>('register-btn').disabled = true;
  out.textContent = 'Registering. This can take up to a minute…';
  try {
    const res = await withKey<OnboardingResponse>('registerNumber', { pin } satisfies Partial<RegisterNumberRequest>);
    out.textContent = '';
    await showStep(res.step ?? 'templates');
  } catch (err) {
    out.textContent = `${errorMessage(err)}. Meta allows 10 registration attempts per number in 72 hours, so check the PIN before trying again.`;
  } finally {
    el<HTMLButtonElement>('register-btn').disabled = false;
  }
});

// Sync (coexistence)
const SYNC_TYPES: SyncType[] = ['contacts', 'history'];

function describe(s: SyncStatus | undefined): string {
  if (!s || s.state === 'none') return 'not requested';
  if (s.state === 'requesting') return 'being requested…';
  if (s.state === 'failed') return `failed: ${s.error ?? 'unknown error'}`;
  return `requested ${new Date(s.at ?? 0).toLocaleString()}`;
}

async function renderSync() {
  const data = await loadNumber();
  el('sync-contacts').textContent = describe(data?.sync?.contacts);
  el('sync-history').textContent = describe(data?.sync?.history);
  const both = SYNC_TYPES.every((t) => data?.sync?.[t]?.state === 'requested');
  const anyFailed = SYNC_TYPES.some((t) => data?.sync?.[t]?.state === 'failed');
  el<HTMLButtonElement>('sync-btn').disabled = both;
  el('sync-btn').textContent = anyFailed ? 'Retry' : 'Start sync';
  el<HTMLButtonElement>('sync-done-btn').disabled = !both;
  el('sync-deadline').textContent = data?.activatedAt
    ? `Onboarded ${new Date(data.activatedAt).toLocaleString()}. Meta's 24 hours end ${new Date(data.activatedAt + 24 * 3600 * 1000).toLocaleString()}.`
    : '';
}

el('sync-btn').addEventListener('click', async () => {
  const out = el('sync-status');
  el<HTMLButtonElement>('sync-btn').disabled = true;
  out.textContent = 'Requesting…';
  try {
    for (const syncType of SYNC_TYPES) {
      const data = await loadNumber();
      if (data?.sync?.[syncType]?.state === 'requested') continue;
      await withKey('startSync', { syncType } satisfies Partial<StartSyncRequest>);
    }
    out.textContent = 'Both requested. Your endpoint now receives the data.';
  } catch (err) {
    out.textContent = errorMessage(err);
  }
  await renderSync();
});

el('sync-done-btn').addEventListener('click', async () => {
  try {
    await moveTo('templates');
  } catch (err) {
    el('sync-status').textContent = errorMessage(err);
  }
});

// Templates
async function renderTemplates() {
  const data = await loadNumber();
  el<HTMLInputElement>('tpl2-source').value ||= tplSource.value.trim() || data?.onboarding?.templateSourceWabaId || '';
  if (templateList && !el<HTMLTextAreaElement>('tpl2-json').value) el<HTMLTextAreaElement>('tpl2-json').value = JSON.stringify(templateList);

  const found = el('tpl-found');
  found.textContent = 'Looking for templates in this number\'s Messaging account…';
  try {
    const res = await fetch(`${functionsBase()}/templates/${encodeURIComponent(phoneNumberId!)}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
    const body = (await res.json()) as { data?: unknown[]; error?: { message?: string } | string };
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : (body.error?.message ?? `HTTP ${res.status}`));
    const count = body.data?.length ?? 0;
    found.textContent = count
      ? `This number's Messaging account already has ${count} template${count === 1 ? '' : 's'}. You can bring more across below, or finish.`
      : 'No templates found yet. Bring them across below, or finish and create new ones later.';
  } catch (err) {
    found.textContent = `Could not read the templates (${errorMessage(err)}). Enter your API key above, or finish and check later.`;
  }
}

el('tpl2-migrate').addEventListener('click', async () => {
  const out = el('tpl2-migrate-status');
  const sourceWabaId = el<HTMLInputElement>('tpl2-source').value.trim();
  if (!ID_RE.test(sourceWabaId)) {
    out.textContent = 'Enter the previous Messaging account ID (digits only).';
    return;
  }
  el<HTMLButtonElement>('tpl2-migrate').disabled = true;
  out.textContent = 'Copying…';
  try {
    const res = await withKey<MigrateTemplatesResponse>('migrateTemplates', { sourceWabaId } satisfies Partial<MigrateTemplatesRequest>);
    if (res.outcome === 'unreadable') {
      out.textContent = 'We can\'t read that account. Either Watobot has not been added as a partner on it, or it belongs to your provider. Check the partner step, or ask your provider for the template list and create them below.';
    } else {
      const failed = res.failed ?? [];
      out.textContent =
        `${res.migrated} template${res.migrated === 1 ? '' : 's'} copied.` +
        (failed.length ? ` ${failed.length} could not be: ${failed.map((f) => `${f.id} (${f.reason})`).join(', ')}.` : '') +
        ' Check them in your Messaging account.';
    }
  } catch (err) {
    out.textContent = errorMessage(err);
  } finally {
    el<HTMLButtonElement>('tpl2-migrate').disabled = false;
  }
});

el('tpl2-import').addEventListener('click', async () => {
  const out = el('tpl2-import-status');
  let templates: unknown;
  try {
    templates = JSON.parse(el<HTMLTextAreaElement>('tpl2-json').value);
  } catch {
    out.textContent = 'That is not valid JSON.';
    return;
  }
  el<HTMLButtonElement>('tpl2-import').disabled = true;
  out.textContent = 'Creating… this can take a while.';
  try {
    const res = await withKey<ImportTemplatesResponse>('importTemplates', { templates } satisfies Partial<ImportTemplatesRequest>);
    const failed = res.failed ?? [];
    out.textContent =
      `${res.created} created, waiting for Meta's review.` +
      (failed.length ? ` ${failed.length} failed: ${failed.map((f) => `${f.name} (${f.reason})`).join('; ')}.` : '');
  } catch (err) {
    out.textContent = errorMessage(err);
  } finally {
    el<HTMLButtonElement>('tpl2-import').disabled = false;
  }
});

el('tpl-finish').addEventListener('click', async () => {
  try {
    await moveTo('done');
  } catch (err) {
    fail(errorMessage(err));
  }
});

// --- Boot ------------------------------------------------------------------------------------

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid, resumeId);

  // An account with no API key yet creates one first, on the key page.
  const hasKey = Boolean(((await getDoc(doc(db, 'users', user.uid))).data() as UserDoc | undefined)?.apiKeyHash);
  if (!hasKey) {
    location.replace('/dashboard/key/');
    return;
  }
  el('key-card').classList.remove('hidden');

  if (!resumeId) {
    status.textContent = 'Enter your API key to continue.';
    show('view-start');
    initEmbeddedSignup();
    return;
  }

  // Picking up a number that is part-way through.
  const data = await loadNumber().catch(() => undefined);
  if (!data) {
    status.textContent = 'We could not find that number under your account.';
    return;
  }
  if (!data.onboarding || data.onboarding.step === 'done') {
    location.href = `/dashboard/waba/?id=${encodeURIComponent(resumeId)}`;
    return;
  }
  status.textContent = 'Enter your API key to carry on where you left off.';
  if (data.overrideUrl) callbackUrl = data.overrideUrl;
  await showStep(data.onboarding.step);
  if (data.onboarding.error) fail(data.onboarding.error);
});
