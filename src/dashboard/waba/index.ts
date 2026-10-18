import { auth, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { isValidApiKey } from '/assets/api-key.js';
import '/assets/nav-auth.js';
import { wireTestEvents } from '/assets/test-events.js';
import { el, errorMessage } from '/assets/dom.js';
import type { NumberView, SetWebhookRequest, SyncStatus } from '../../../functions/src/helpers/types';
import { effectiveConfig, view } from '../../../functions/src/helpers/rateLimiter';
import { fetchNumber } from '/assets/account.js';
import { LIMITED_DAILY_TEMPLATES } from '../../../functions/src/helpers/health';

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

function renderLimitTable(data: NumberView, nowMs: number) {
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
function renderStats(data: NumberView) {
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


/** "requested 16 Oct 2026, 10:12", or what went wrong. */
function syncText(s: SyncStatus | undefined): string {
  if (!s || s.state === 'none') return 'not requested';
  if (s.state === 'requesting') return 'being requested';
  if (s.state === 'failed') return `failed (${s.error ?? 'unknown error'})`;
  if (s.state === 'skipped') return 'skipped';
  return `requested ${new Date(s.at ?? 0).toLocaleString()}`;
}

/** For a coexistence number: when the contacts and history syncs were requested. */
function renderSyncCard(data: NumberView) {
  const card = el('onboarding-card');
  card.replaceChildren();
  const line = (text: string, className = 'text-on-surface-variant font-body-md text-sm') => {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    card.append(p);
  };

  if (!data.isOnBizApp) return;
  line(`Contacts sync: ${syncText(data.sync?.contacts)}`);
  line(`History sync: ${syncText(data.sync?.history)}`);
  card.classList.remove('hidden');
}

// Only the owner gets a number's record (getNumber). Returns false if the record
// is missing or isn't this user's; the page still works then, just without the saved details.
async function loadRecord(): Promise<boolean> {
  let data: NumberView | undefined;
  try {
    data = await fetchNumber(phoneNumberId);
  } catch {
    return false;
  }
  if (!data) return false;

  if (data.overrideUrl && !overrideUrl.value) overrideUrl.value = data.overrideUrl;

  // The number is the title; whether it also runs on the Business app is a chip beside it.
  if (data.displayPhoneNumber) el('page-title').textContent = data.displayPhoneNumber;
  renderIds(data.wabaId);
  if (data.isOnBizApp !== undefined) {
    const chip = el('type-chip');
    chip.textContent = data.isOnBizApp ? 'Coexistence' : 'API only';
    chip.className = `rounded-full px-3 py-1 label-strong ${data.isOnBizApp ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'}`;
  }
  // A number that needs a step (no URL saved, no longer connected, syncs not requested, or onboarding
  // unfinished) goes to the wizard, which opens at that step.
  if (data.step !== 'done') {
    location.replace(`/dashboard/waba/create.html?id=${encodeURIComponent(phoneNumberId)}`);
    return true;
  }
  renderSyncCard(data);
  renderHealth(data);
  renderStats(data);
  return true;
}

// --- Sending status and display name ------------------------------------------------

const HEALTH_CHIP = {
  ok: ['Can send', 'bg-primary/10 text-primary'],
  limited: ['Limited', 'bg-amber-100 text-amber-900'],
  blocked: ['Blocked', 'bg-error/10 text-error'],
} as const;
const HEALTH_EFFECT = {
  ok: 'Nothing is in the way of sending.',
  limited: `Template messages are limited to ${LIMITED_DAILY_TEMPLATES} a day until this clears. Replies in a chat are not limited.`,
  blocked: 'Template messages are refused. Free-form replies in a chat still go through.',
} as const;

/** Shows the stored status and display name. Nothing here asks Meta: the refresh button does. */
function renderHealth(data: NumberView) {
  el('health-card').classList.remove('hidden');
  const health = data.health;
  const chip = el('health-chip');
  const [label, classes] = health ? HEALTH_CHIP[health.status] : (['Not checked yet', 'bg-surface-container text-on-surface-variant'] as const);
  chip.textContent = label;
  chip.className = `rounded-full px-3 py-1 label-strong ${classes}`;
  el('health-checked').textContent = health
    ? `${health.source === 'refusal' ? 'Learned from a send Meta refused' : 'Checked'} ${new Date(health.checkedAt).toLocaleString()}`
    : '';
  el('health-effect').textContent = health ? HEALTH_EFFECT[health.status] : 'Refresh to ask Meta whether this number can send.';

  const list = el('health-reasons');
  list.replaceChildren();
  for (const reason of health?.reasons ?? []) {
    const item = document.createElement('li');
    item.className = reason.severity === 'info' ? 'opacity-80' : '';
    const text = document.createElement('span');
    text.textContent = `${reason.message}${reason.fix ? ` ${reason.fix}` : ''}`;
    const tag = document.createElement('span');
    tag.className = 'label-muted mr-2';
    tag.textContent = `${reason.scope.replace('_', ' ')}${reason.code ? ` ${reason.code}` : ''}${reason.severity === 'info' ? ' · for information' : ''}`;
    item.append(tag, text);
    list.append(item);
  }

  const name = data.displayName;
  const pending = /PENDING/i.test(name?.requestedStatus ?? '');
  el('display-name-state').textContent = name?.name
    ? `${name.name} (${name.status ?? 'status unknown'})${name.requestedName && name.requestedStatus && name.requestedStatus !== 'NONE' ? `. Requested: ${name.requestedName} (${name.requestedStatus}).` : ''}`
    : 'Not read yet. Refresh to see it.';
  el<HTMLButtonElement>('display-name-btn').disabled = pending;
  el('display-name-note').classList.toggle('opacity-60', pending);
}

/** Asks Meta again, with the key (it opens the stored token), and shows what came back. */
async function postWithKey(path: string, body: object) {
  const res = await fetch(`${functionsBase()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumberId, apiKey: apiKeyInput.value.trim(), ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; number?: NumberView; metaError?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshHealth() {
  const status = el('health-status');
  if (!isValidApiKey(apiKeyInput.value.trim())) {
    status.textContent = 'Enter your API key first (the box further down).';
    return;
  }
  el<HTMLButtonElement>('health-refresh').disabled = true;
  status.textContent = 'Asking Meta…';
  try {
    const result = await postWithKey('getNumber', {});
    if (result.metaError) throw new Error(result.metaError);
    renderHealth(result.number!);
    status.textContent = 'Updated.';
  } catch (err) {
    status.textContent = `Could not refresh: ${errorMessage(err)}`;
  } finally {
    el<HTMLButtonElement>('health-refresh').disabled = false;
  }
}
el('health-refresh').addEventListener('click', refreshHealth);

el('display-name-btn').addEventListener('click', async () => {
  const status = el('health-status');
  const displayName = el<HTMLInputElement>('display-name-input').value.trim();
  if (!isValidApiKey(apiKeyInput.value.trim()) || displayName.length < 3) {
    status.textContent = 'Enter your API key (further down) and a name of at least 3 characters.';
    return;
  }
  el<HTMLButtonElement>('display-name-btn').disabled = true;
  status.textContent = 'Sending the request to Meta…';
  try {
    await postWithKey('setDisplayName', { displayName });
    status.textContent = 'Sent. Meta now reviews it; refresh later to see the decision.';
    await refreshHealth();
  } catch (err) {
    status.textContent = `Not sent: ${errorMessage(err)}`;
    el<HTMLButtonElement>('display-name-btn').disabled = false;
  }
});

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


  el<HTMLTextAreaElement>('deregister-command').value = [
    `curl -X POST '${base}/deregisterNumber' \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ phoneNumberId, apiKey: key })}'`,
  ].join('\n');
  el<HTMLTextAreaElement>('tpl-migrate-command').value = [
    `curl -X POST '${base}/templates/${phoneNumberId}/migrate' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ sourceWabaId: 'PREVIOUS_MESSAGING_ACCOUNT_ID' })}'`,
  ].join('\n');
  el<HTMLTextAreaElement>('tpl-import-command').value = [
    `curl -X POST '${base}/templates/${phoneNumberId}/import' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '{"templates":[ ...the exported templates... ]}'`,
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
  ['copy-deregister-btn', 'deregister-command'],
  ['copy-tpl-import-btn', 'tpl-import-command'],
  ['copy-tpl-migrate-btn', 'tpl-migrate-command'],
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
