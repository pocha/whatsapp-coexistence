import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { isValidApiKey } from '/assets/api-key.js';
import '/assets/nav-auth.js';
import { wireTestEvents } from '/assets/test-events.js';
import { el, errorMessage } from '/assets/dom.js';
import type { OnboardingStep, PhoneNumberDoc, SetWebhookRequest, SyncStatus } from '../../../functions/src/helpers/types';
import { effectiveConfig, view } from '../../../functions/src/helpers/rateLimiter';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// The page for one number, identified by ?id= in the URL (its phone number ID). Signed-in
// only: signed-out visitors are sent to the Dashboard's sign-in. What it does to the number
// is authorised by the Watobot API key typed at the top, and it never writes to Firestore.
const phoneNumberId = new URLSearchParams(location.search).get('id') ?? '';

const apiKeyInput = el<HTMLInputElement>('api-key');
const overrideUrl = el<HTMLInputElement>('ov-url');
const overrideBtn = el<HTMLButtonElement>('ov-btn');
const overrideStatus = el('ov-status');

// Same date-key algorithm as functions/src/wabaManager.ts, duplicated here
// (small and pure) so usage lookups match the keys the relay wrote.
const dailyKey = (d: Date) => d.toISOString().slice(0, 10);
const monthlyKey = (d: Date) => d.toISOString().slice(0, 7);
function isoWeekKey(d: Date) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// One tile: the count for this period, with the previous one under it.
function tile(label: string, current: number, previous: number): HTMLElement {
  const box = document.createElement('div');
  box.className = 'rounded-lg border border-outline-variant p-3 text-center';

  const name = document.createElement('p');
  name.className = 'label-muted';
  name.textContent = label;

  const big = document.createElement('p');
  big.className = 'font-headline-md text-headline-md text-on-surface';
  big.textContent = current.toLocaleString();

  const small = document.createElement('p');
  small.className = 'text-on-surface-variant font-body-md text-sm';
  small.textContent = `prev ${previous.toLocaleString()}`;

  box.append(name, big, small);
  return box;
}

/** "10 / 15": accepted in green, then everything that was attempted in grey. */
function pair(accepted: number, attempted: number): HTMLElement {
  const cell = document.createElement('span');
  const good = document.createElement('strong');
  good.className = 'text-primary';
  good.textContent = accepted.toLocaleString();
  const all = document.createElement('span');
  all.className = 'text-muted';
  all.textContent = ` / ${attempted.toLocaleString()}`;
  cell.append(good, all);
  return cell;
}

// An "i" that opens a short note when clicked. Click, not hover, so it works on touch screens too;
// only one note is open at a time and a click anywhere else closes it.
let openNote: HTMLElement | null = null;
function closeNote() {
  openNote?.classList.add('hidden');
  openNote = null;
}
document.addEventListener('click', closeNote);

function infoIcon(text: string, align: 'left' | 'right'): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'relative inline-block align-middle ml-1';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cursor-pointer leading-none text-on-surface-variant hover:text-primary';
  button.textContent = 'ⓘ';
  button.setAttribute('aria-label', 'More information');

  // Opens upwards: the table sits at the bottom of its card, which would clip a note below it.
  const note = document.createElement('span');
  note.setAttribute('role', 'tooltip');
  note.className = `hidden absolute bottom-full z-20 mb-1 w-56 rounded-lg bg-inverse-surface p-2 text-left text-xs font-normal text-inverse-on-surface shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`;
  note.textContent = text;

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = openNote === note;
    closeNote();
    if (!wasOpen) {
      note.classList.remove('hidden');
      openNote = note;
    }
  });
  wrap.append(button, note);
  return wrap;
}

function renderLimitTable(data: PhoneNumberDoc, nowMs: number) {
  const config = effectiveConfig(data.rateLimits);
  const windows = view(data.rateState, config, nowMs);
  const units = [
    ['minute', 'Minute'],
    ['hour', 'Hour'],
    ['day', 'Day'],
  ] as const;

  // The allowance is what a sender runs into; how it is worked out sits in a note behind an "i",
  // so the table stays at three rows.
  const allowanceNote = (u: (typeof units)[number][0]) =>
    `Grows with usage: up to ${config[u].growthPercent}% over the previous ${u}, and never below ${config[u].floor}.`;

  const rows: [string, (u: (typeof units)[number][0]) => Node | string, string?][] = [
    ['This window', (u) => pair(windows[u].current, windows[u].currentAttempts)],
    ['Previous', (u) => pair(windows[u].previous, windows[u].previousAttempts)],
    [
      'Current allowance',
      (u) => {
        const full = windows[u].current >= windows[u].limit;
        const cell = document.createElement('span');
        const value = document.createElement('span');
        value.className = `${full ? 'text-error ' : ''}font-bold`;
        value.textContent = windows[u].limit.toLocaleString();
        cell.append(value, infoIcon(allowanceNote(u), 'right'));
        return cell;
      },
      'The most this number may send in the window. It keeps increasing as you send more.',
    ],
  ];

  const table = el<HTMLTableElement>('limit-table');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  head.append(document.createElement('th'));
  for (const [, label] of units) {
    const th = document.createElement('th');
    th.className = 'label-muted text-right pb-2';
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const [label, cellFor, hint] of rows) {
    const row = body.insertRow();
    row.className = 'border-t border-outline-variant';
    const name = row.insertCell();
    name.className = 'py-2 pr-3 text-on-surface-variant';
    name.textContent = label;
    if (hint) name.append(infoIcon(hint, 'left'));
    for (const [unit] of units) {
      const cell = row.insertCell();
      cell.className = 'py-2 text-right';
      cell.append(cellFor(unit));
    }
  }
  if (!config.enabled) {
    const note = document.createElement('caption');
    note.className = 'text-left text-on-surface-variant pb-2';
    note.textContent = 'Rate limiting is switched off for this number.';
    table.prepend(note);
  }
}

// Messages sent come from the date-keyed usage counters (previous period = the earlier key);
// rate limiting from the relay's window counts, advanced to now the same way the relay does.
function renderStats(data: PhoneNumberDoc) {
  const now = new Date();
  const usage = data.usage ?? {};
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  el('sent-tiles').replaceChildren(
    tile('Today', usage.daily?.[dailyKey(now)] ?? 0, usage.daily?.[dailyKey(dayAgo)] ?? 0),
    tile('This week', usage.weekly?.[isoWeekKey(now)] ?? 0, usage.weekly?.[isoWeekKey(weekAgo)] ?? 0),
    tile('This month', usage.monthly?.[monthlyKey(now)] ?? 0, usage.monthly?.[monthlyKey(monthAgo)] ?? 0),
  );

  renderLimitTable(data, now.getTime());
  el('stats').classList.remove('hidden');
}

/** The IDs under the title. The Messaging account's ID is what used to be called the WABA ID. */
function renderIds(messagingAccountId: string | undefined) {
  const lines = [`Phone number ID: ${phoneNumberId}`];
  if (messagingAccountId) lines.push(`Messaging account ID (previously WABA ID): ${messagingAccountId}`);
  el('ids-line').replaceChildren(
    ...lines.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );
}

const STEP_NAMES: Record<OnboardingStep, string> = {
  override: 'connecting your callback URL',
  not_on_app: 'choosing coexistence or API only',
  register: 'registering the number',
  sync: 'syncing contacts and chat history',
  templates: 'bringing your templates across',
  done: 'done',
};

/** "requested 16 Oct 2026, 10:12", or what went wrong. */
function syncText(s: SyncStatus | undefined): string {
  if (!s || s.state === 'none') return 'not requested';
  if (s.state === 'requesting') return 'being requested';
  if (s.state === 'failed') return `failed (${s.error ?? 'unknown error'})`;
  return `requested ${new Date(s.at ?? 0).toLocaleString()}`;
}

/** The number's state at the top of the page: unfinished onboarding, or how it is connected and when its syncs were requested. */
function renderOnboardingCard(data: PhoneNumberDoc) {
  const card = el('onboarding-card');
  card.replaceChildren();
  const line = (text: string, className = 'text-on-surface-variant font-body-md text-sm') => {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    card.append(p);
  };

  if (data.onboarding && data.onboarding.step !== 'done') {
    card.classList.add('whatsapp-border');
    line('ONBOARDING NOT FINISHED', 'label-strong text-primary mb-1');
    line(`This number is at the step: ${STEP_NAMES[data.onboarding.step]}.`);
    if (data.onboarding.error) line(`Last problem: ${data.onboarding.error}`, 'text-error font-body-md text-sm mt-1');
    const link = document.createElement('a');
    link.href = `/dashboard/waba/create.html?id=${encodeURIComponent(phoneNumberId)}`;
    link.className = 'inline-block mt-3 rounded-xl bg-primary text-on-primary px-6 py-3 font-label-md text-label-md font-bold hover:opacity-90 transition-all';
    link.textContent = 'Continue onboarding';
    card.append(link);
  } else if (data.isOnBizApp) {
    line(`Contacts sync: ${syncText(data.sync?.contacts)}`);
    line(`History sync: ${syncText(data.sync?.history)}`);
  } else {
    return;
  }
  card.classList.remove('hidden');
}

// The rules let just the owner read phoneNumbers/{phoneNumberId}. Returns false if the record
// is missing or isn't this user's; the page still works then, just without the saved details.
async function loadRecord(): Promise<boolean> {
  let data: PhoneNumberDoc | undefined;
  try {
    data = (await getDoc(doc(db, 'phoneNumbers', phoneNumberId))).data() as PhoneNumberDoc | undefined;
  } catch {
    return false;
  }
  if (!data) return false;

  if (data.overrideUrl && !overrideUrl.value) overrideUrl.value = data.overrideUrl;

  // The number is the title; whether it also runs on the Business app is a chip beside it.
  if (data.displayPhoneNumber) el('page-title').textContent = data.displayPhoneNumber;
  renderIds(data.wabaId);
  const finished = !data.onboarding || data.onboarding.step === 'done';
  if (data.deregisteredAt) {
    const chip = el('type-chip');
    chip.textContent = 'De-registered';
    chip.className = 'rounded-full px-3 py-1 label-strong bg-error/10 text-error';
  } else if (finished && data.isOnBizApp !== undefined) {
    const chip = el('type-chip');
    chip.textContent = data.isOnBizApp ? 'Coexistence' : 'API only';
    chip.className = `rounded-full px-3 py-1 label-strong ${data.isOnBizApp ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'}`;
  }
  renderOnboardingCard(data);
  renderStats(data);
  return true;
}

// --- Override incoming message URL ------------------------------------------
el('chatbot-env').textContent =
  `WEBHOOK_VERIFY_TOKEN=${WEBHOOK_VERIFY_TOKEN}\nRELAY_BASE=${functionsBase()}/relayMessage\nWATOBOT_API_KEY=`;
el('copy-env-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(el('chatbot-env').textContent ?? '');
  el('copy-env-btn').textContent = 'Copied';
});

wireTestEvents(() => overrideUrl.value);

overrideBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const overrideCallbackUrl = overrideUrl.value.trim();
  if (!apiKey || !overrideCallbackUrl) {
    overrideStatus.textContent = 'Fill in your API key (at the top) and your URL.';
    return;
  }

  overrideBtn.disabled = true;
  overrideStatus.textContent = 'Checking your URL and updating WhatsApp…';
  try {
    const res = await fetch(`${functionsBase()}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId, apiKey, overrideCallbackUrl } satisfies SetWebhookRequest),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      overrideStatus.textContent = `Not saved: ${body.error || `HTTP ${res.status}`}`;
      return;
    }
    // The function records the URL itself; just refresh the sidebar.
    overrideStatus.textContent = 'Done: incoming messages now go to your URL.';
    fillSidebar(auth.currentUser!.uid, phoneNumberId);
  } catch (err) {
    overrideStatus.textContent = `Request failed: ${errorMessage(err)}`;
  } finally {
    overrideBtn.disabled = false;
  }
});

// --- Commands to copy: sending a message and managing templates -------------
// The API key typed at the top is filled into the commands, so they can be pasted as they are.
function renderCommands() {
  const typed = apiKeyInput.value.trim();
  const key = isValidApiKey(typed) ? typed : 'YOUR_WATOBOT_API_KEY';
  const base = functionsBase();
  const auth = `-H 'Authorization: Bearer ${key}'`;
  const json = `-H 'Content-Type: application/json'`;

  // A template, because free-form text is only delivered within 24 hours of the customer's last
  // message. hello_world is the sample template Meta provides on new accounts.
  const message = JSON.stringify({
    messaging_product: 'whatsapp',
    to: 'RECIPIENT_PHONE_NUMBER',
    type: 'template',
    template: { name: 'hello_world', language: { code: 'en_US' } },
  });
  el<HTMLTextAreaElement>('send-command').value = [
    `curl -X POST '${base}/relayMessage/${phoneNumberId}/messages' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${message}'`,
  ].join('\n');

  // Free-form text: only delivered within 24 hours of the customer's last message to the number.
  const text = JSON.stringify({
    messaging_product: 'whatsapp',
    to: 'RECIPIENT_PHONE_NUMBER',
    type: 'text',
    text: { body: 'Hello from Watobot' },
  });
  el<HTMLTextAreaElement>('send-text-command').value = [
    `curl -X POST '${base}/relayMessage/${phoneNumberId}/messages' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${text}'`,
  ].join('\n');

  // Only for a brand-new number (not coexistence): Meta needs it registered before it can send.
  const register = JSON.stringify({ phoneNumberId, apiKey: key, pin: 'YOUR_6_DIGIT_PIN' });
  el<HTMLTextAreaElement>('register-command').value = [
    `curl -X POST '${base}/registerNumber' \\`,
    `  ${json} \\`,
    `  -d '${register}'`,
  ].join('\n');

  el<HTMLTextAreaElement>('status-command').value = [
    `curl -X POST '${base}/numberStatus' \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ phoneNumberId, apiKey: key })}'`,
  ].join('\n');

  el<HTMLTextAreaElement>('deregister-command').value = [
    `curl -X POST '${base}/deregisterNumber' \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ phoneNumberId, apiKey: key })}'`,
  ].join('\n');
  el<HTMLTextAreaElement>('tpl-migrate-command').value = [
    `curl -X POST '${base}/migrateTemplates' \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ phoneNumberId, apiKey: key, sourceWabaId: 'PREVIOUS_MESSAGING_ACCOUNT_ID' })}'`,
  ].join('\n');
  el<HTMLTextAreaElement>('tpl-import-command').value = [
    `curl -X POST '${base}/importTemplates' \\`,
    `  ${json} \\`,
    `  -d '{"phoneNumberId":"${phoneNumberId}","apiKey":"${key}","templates":[ ...the exported templates... ]}'`,
  ].join('\n');

  const create = JSON.stringify({
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Your order {{1}} has shipped.', example: { body_text: [['A1234']] } }],
  });
  const edit = JSON.stringify({
    components: [{ type: 'BODY', text: 'Your order {{1}} is on its way.', example: { body_text: [['A1234']] } }],
  });
  const put = (id: string, lines: string[]) => {
    el<HTMLTextAreaElement>(id).value = lines.join('\n');
  };
  put('tpl-list-command', [`curl '${base}/templates/${phoneNumberId}' \\`, `  ${auth}`]);
  put('tpl-create-command', [
    `curl -X POST '${base}/templates/${phoneNumberId}' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${create}'`,
  ]);
  put('tpl-edit-command', [
    `curl -X POST '${base}/templates/${phoneNumberId}/TEMPLATE_ID' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${edit}'`,
  ]);
  put('tpl-delete-command', [
    `curl -X DELETE '${base}/templates/${phoneNumberId}?name=order_update' \\`,
    `  ${auth}`,
  ]);
}
apiKeyInput.addEventListener('input', renderCommands);

for (const [button, box] of [
  ['copy-send-btn', 'send-command'],
  ['copy-send-text-btn', 'send-text-command'],
  ['copy-status-btn', 'status-command'],
  ['copy-deregister-btn', 'deregister-command'],
  ['copy-tpl-import-btn', 'tpl-import-command'],
  ['copy-tpl-migrate-btn', 'tpl-migrate-command'],
  ['copy-register-btn', 'register-command'],
  ['copy-tpl-list-btn', 'tpl-list-command'],
  ['copy-tpl-create-btn', 'tpl-create-command'],
  ['copy-tpl-edit-btn', 'tpl-edit-command'],
  ['copy-tpl-delete-btn', 'tpl-delete-command'],
]) {
  el(button).addEventListener('click', async () => {
    await navigator.clipboard.writeText(el<HTMLTextAreaElement>(box).value);
    el(button).textContent = 'Copied';
  });
}

// --- Accordions: opening one closes the others ---------------------------------
const accordions = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-accordion]'));
for (const item of accordions) {
  item.addEventListener('toggle', () => {
    if (!item.open) return;
    for (const other of accordions) if (other !== item) other.open = false;
  });
}

// --- Boot ---------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid, phoneNumberId);
  renderIds(undefined);
  // What the buttons and commands do is authorised by the API key, not by this sign-in, so
  // the sections show either way.
  renderCommands();
  el('key-card').classList.remove('hidden');
  el('sections').classList.remove('hidden');
  if (!(await loadRecord())) el('not-found').classList.remove('hidden');
});
