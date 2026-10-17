import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { META_APP_ID, META_CONFIG_ID, WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { isValidApiKey } from '/assets/api-key.js';
import { callAsUser, fetchNumber, keyMatchesAccount } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { wireTestEvents } from '/assets/test-events.js';
import type {
  ExchangeCodeRequest,
  ImportTemplatesResponse,
  MigrateTemplatesResponse,
  OnboardingResponse,
  OnboardingStep,
  NumberView,
  RegisterNumberRequest,
  SetOnboardingStepRequest,
  SetWebhookRequest,
  SignupEvent,
  StartSyncRequest,
  SyncStatus,
  SyncType,
  UserDoc,
} from '../../../functions/src/helpers/types';

// The onboarding wizard. Before Meta's popup opens it checks what the user will need afterwards
// (a callback URL that handles the data Meta sends, the Business app, where their templates are).
// Once the popup finishes the number has a record, which keeps the step the wizard is at, so
// "?id=<phone number ID>" picks it up again after a reload or a failure. Until then nothing is
// stored anywhere: the URL and what the user entered live in this page only.

const params = new URLSearchParams(location.search);
const resumeId = params.get('id');
// A link from the MCP (or any tool) that has already done steps 2 to 4: it carries the callback URL
// it checked. Nothing on the server depends on those steps, so the page takes the link's word for
// it and, once the key is entered, goes straight to Meta's sign-up.
const linkedCallback = params.get('checks') === 'done' ? (params.get('callback') ?? '') : '';

const keyInput = el<HTMLInputElement>('key-input');
const status = el('onboarding-status');
const lastError = el('last-error');
// The sub-views of steps 6 and 7. Steps 1 to 5 are plain panels.
const VIEWS = ['view-override', 'view-not-on-app', 'view-register', 'view-sync', 'view-templates'];
const STEP_OF: Record<string, number> = {
  'view-override': 6,
  'view-not-on-app': 6,
  'view-register': 6,
  'view-sync': 6,
  'view-templates': 7,
};
const TOTAL_STEPS = 7;
const STEP_TITLES = [
  'Enter your Watobot API key',
  'Testing your callback URL',
  'Checking the number on the WhatsApp Business app',
  'Message template check',
  'Onboard to WhatsApp API through Meta',
  'Sync your contacts, or register the number',
  'Bring your message templates across',
];

const wizard = el('wizard');

/** Greys the whole window out with a spinner, so nothing is clicked while we wait for something. */
let busyTimer: ReturnType<typeof setTimeout> | undefined;
function busy(text: string | null) {
  clearTimeout(busyTimer);
  el('wizard-busy').classList.toggle('hidden', text === null);
  el('wizard-busy').classList.toggle('flex', text !== null);
  el('wizard-busy-text').textContent = text ?? '';
  if (text !== null) {
    // A way out if something never answers.
    busyTimer = setTimeout(() => {
      busy(null);
      fail('This is taking longer than expected. If your number now shows in the sidebar, open it to carry on; otherwise try again.');
    }, 120_000);
  }
}
const backBtn = el<HTMLButtonElement>('wizard-back');
const nextBtn = el<HTMLButtonElement>('wizard-next');
let currentStep = 1;
// Once Meta's popup has finished the number has a record, and closing the window leaves the page.
let numberExists = false;

function goStep(n: number) {
  currentStep = n;
  for (let i = 1; i <= TOTAL_STEPS; i++) el(`step-${i}`).classList.toggle('hidden', i !== n);
  el('wizard-step-label').textContent = `Step ${n} of ${TOTAL_STEPS} · ${STEP_TITLES[n - 1]}`;
  Array.from(el('wizard-progress').children).forEach((bar, i) => {
    bar.classList.toggle('bg-primary', i < n);
    bar.classList.toggle('bg-surface-container-high', i >= n);
  });
  refreshNav();
  // Focus goes to the first thing to do in the step.
  requestAnimationFrame(() => el(`step-${n}`).querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), textarea, button')?.focus());
}

/** Shows one of the sub-views in step 6 or 7 (and the step it belongs to). */
function show(view: string | null) {
  for (const id of VIEWS) el(id).classList.toggle('hidden', id !== view);
  if (!view) return;
  goStep(STEP_OF[view]);
  // Step 6 is one of four things, depending on the number.
  const title: Record<string, string> = {
    'view-override': 'Connect your callback URL',
    'view-not-on-app': 'Choose how to continue',
    'view-register': 'Register the number',
    'view-sync': 'Sync your contacts and chat history',
  };
  if (title[view]) el('wizard-step-label').textContent = `Step 6 of ${TOTAL_STEPS} · ${title[view]}`;
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
// When resuming: the step the number is at, to open once the key has been entered.
let resumeStep: OnboardingStep | null = null;

const apiKey = () => keyInput.value.trim();

/** POSTs to a path under templates/<number> with the Watobot API key as the bearer token. */
async function templatesCall<T extends { ok: boolean; error?: string }>(path: string, body: object): Promise<T> {
  const res = await fetch(`${functionsBase()}/templates/${encodeURIComponent(phoneNumberId!)}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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

async function loadNumber(): Promise<NumberView> {
  return fetchNumber(phoneNumberId!);
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
  refreshNav();
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
    refreshNav();
  },
);

cbUrl.addEventListener('input', () => {
  urlVerified = false;
  cbStatus.textContent = '';
  refreshNav();
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
  refreshNav();
});

// The test chatbot's settings, for someone who has no endpoint yet (same as on the number page).
el('chatbot-env').textContent =
  `WEBHOOK_VERIFY_TOKEN=${WEBHOOK_VERIFY_TOKEN}\nRELAY_BASE=${functionsBase()}/relayMessage\nWATOBOT_API_KEY=`;
el('copy-env-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(el('chatbot-env').textContent ?? '');
  el('copy-env-btn').textContent = 'Copied';
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

/** Marks steps 2 to 4 as done, as the link says they are. */
function takeLinkedChecks() {
  cbUrl.value = linkedCallback;
  callbackUrl = linkedCallback;
  urlVerified = true;
  testCodesOk = true;
  for (const id of ['cb-confirm', 'app-confirm']) el<HTMLInputElement>(id).checked = true;
  const none = tplRadios.find((r) => r.value === 'none');
  if (none) none.checked = true;
  readTemplateChoice();
  status.textContent = 'Your callback URL was checked in your AI tool. Enter your API key, then continue to Meta.';
  refreshNav();
}

function readTemplateChoice() {
  templateChoice = (tplRadios.find((r) => r.checked)?.value as typeof templateChoice) ?? null;
  el('tpl-own').classList.toggle('hidden', templateChoice !== 'own');
  el('tpl-provider').classList.toggle('hidden', templateChoice !== 'provider');
}
for (const r of tplRadios) r.addEventListener('change', () => (readTemplateChoice(), refreshNav()));
tplSource.addEventListener('input', refreshNav);
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
  refreshNav();
});

/** What step n still needs before the user can go on, or null when it is done. */
function missingFor(n: number): string | null {
  switch (n) {
    case 1:
      return keyVerified ? null : 'Enter your API key.';
    case 2:
      if (!urlVerified) return 'Verify your callback URL.';
      if (!el<HTMLInputElement>('cb-confirm').checked) return 'Confirm your endpoint stores the data.';
      return testCodesOk ? null : 'Send the test data and check the four codes.';
    case 3:
      return el<HTMLInputElement>('app-confirm').checked ? null : 'Confirm the number is on the WhatsApp Business app.';
    case 4:
      if (templateChoice === null) return 'Say where your templates are.';
      if (templateChoice === 'own' && !ID_RE.test(tplSource.value.trim())) return 'Enter the previous Messaging account ID (digits).';
      if (templateChoice === 'provider' && !templateCount) return 'Paste your provider\'s template list.';
      return null;
    default:
      return null;
  }
}

/** Back and Next follow the step: Next waits for the step to be done, and the later steps have their own buttons. */
function refreshNav() {
  const beforeMeta = currentStep <= 4;
  const gap = missingFor(currentStep);
  nextBtn.classList.toggle('hidden', !beforeMeta);
  nextBtn.disabled = Boolean(gap);
  backBtn.classList.toggle('hidden', currentStep === 1 || currentStep > 5);
  el('wizard-hint').textContent = beforeMeta ? (gap ?? '') : '';

  const everything = [1, 2, 3, 4].every((n) => missingFor(n) === null);
  metaBtn.disabled = !everything || !sdkReady;
  el('meta-hint').textContent = !everything ? 'Go back and finish the earlier steps.' : sdkReady ? '' : 'Loading Meta\'s sign-up…';
}
for (const id of ['cb-confirm', 'app-confirm']) el(id).addEventListener('change', refreshNav);

nextBtn.addEventListener('click', async () => {
  if (currentStep === 1 && linkedCallback) {
    goStep(5);
    return;
  }
  // Picking up a number part-way through: the key is the only thing to ask again.
  if (currentStep === 1 && resumeStep) {
    await showStep(resumeStep);
    return;
  }
  goStep(currentStep + 1);
});
backBtn.addEventListener('click', () => goStep(currentStep - 1));

el('wizard-close').addEventListener('click', () => {
  if (numberExists) {
    location.href = '/dashboard/';
    return;
  }
  wizard.classList.add('hidden');
  el('reopen-btn').classList.remove('hidden');
});
el('reopen-btn').addEventListener('click', () => {
  wizard.classList.remove('hidden');
  el('reopen-btn').classList.add('hidden');
  goStep(currentStep);
});

// --- Meta's popup ----------------------------------------------------------------------------

function initEmbeddedSignup() {
  window.fbAsyncInit = function () {
    FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: 'v26.0' });
    sdkReady = true;
    refreshNav();
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
        busy(null);
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
        // Meta's window is gone: grey ours out until we know how it went.
        if (response.authResponse?.code) {
          busy('Finishing your onboarding…');
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
    busy(null);
    fail(`Could not connect the number: ${errorMessage(err)}`);
    exchanging = false;
    signupCode = null;
    return;
  }
  numberExists = true;
  await connectOverride(callbackUrl);
}

// --- The callback URL ------------------------------------------------------------------------

/** Subscribes the user's URL (and, for a number in the wizard, finds the next step). */
async function connectOverride(url: string) {
  busy('Pointing Meta at your URL…');
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
  } finally {
    busy(null);
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
  numberExists = true;
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
  const saved = (await loadNumber())?.onboarding.error;
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

// Back to the start, for a number that should have been coexistence. The new signup replaces its saved state.
el('restart-btn').addEventListener('click', () => {
  location.href = '/dashboard/waba/create.html';
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
  el<HTMLInputElement>('tpl2-source').value ||= tplSource.value.trim() || data?.onboarding.templateSourceWabaId || '';
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
    const res = await templatesCall<MigrateTemplatesResponse>('migrate', { sourceWabaId });
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
    const res = await templatesCall<ImportTemplatesResponse>('import', { templates });
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

  wizard.classList.remove('hidden');
  goStep(1);

  if (!resumeId) {
    status.textContent = '';
    if (linkedCallback) takeLinkedChecks();
    initEmbeddedSignup();
    return;
  }

  // Picking up a number that is part-way through.
  const data = await loadNumber().catch(() => undefined);
  if (!data) {
    status.textContent = 'We could not find that number under your account.';
    return;
  }
  const step = data.step;
  if (step === 'done') {
    location.href = `/dashboard/waba/?id=${encodeURIComponent(resumeId)}`;
    return;
  }
  status.textContent = 'Enter your API key to carry on where you left off.';
  if (data.overrideUrl) callbackUrl = data.overrideUrl;
  resumeStep = step;
  if (data.onboarding.error) fail(data.onboarding.error);
});
