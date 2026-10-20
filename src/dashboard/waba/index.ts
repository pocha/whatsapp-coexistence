import { auth, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { isValidApiKey } from '/assets/api-key.js';
import '/assets/nav-auth.js';
import { wireTestEvents } from '/assets/test-events.js';
import { el, errorMessage } from '/assets/dom.js';
import type { NumberView, Scope, SetWebhookRequest, SyncStatus } from '../../../functions/src/helpers/types';
import { view } from '../../../functions/src/helpers/rateLimiter';
import { DEFAULT_RATE_LIMITS as config } from '../../../functions/src/helpers/rateLimitConfig';
import { fetchNotifications, fetchNumber } from '/assets/account.js';
import { REFRESH_MIN_INTERVAL_MS } from '../../../functions/src/helpers/health';

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
  const limits = data.health?.limits ?? {};
  const windows = view(data.rateState, data.limits, limits, nowMs);
  const units = [
    ['minute', 'Minute'],
    ['hour', 'Hour'],
    ['day', 'Day'],
  ] as const;

  // The allowance is what a sender runs into; how it is worked out sits in a note behind an "i",
  // so the table stays at three rows.
  const capped = Object.values(data.health?.scopes ?? {}).flatMap((scope) => scope?.issues ?? []).filter((i) => i.cap?.day === limits.day);
  const allowanceNote = (u: (typeof units)[number][0]) => {
    const grows = `Grows with usage: up to ${config[u].growthPercent}% over the previous ${u}, and never below ${config[u].floor}.`;
    if (u !== 'day' || limits.day === undefined) return grows;
    return `${grows} It will not go above ${limits.day} a day, ${capped.length ? capped.map((i) => i.title.toLowerCase()).join(' and ') : "Meta's messaging limit"}.`;
  };

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
  renderChips(data);
  void renderNotifications();
  renderStats(data);
  return true;
}

// --- Sending status chips and their popup ------------------------------------------

const STATUS_CHIP = {
  ok: ['OK', 'bg-primary/10 text-primary'],
  limit: ['Limited', 'bg-amber-100 text-amber-900'],
  block: ['Blocked', 'bg-error/10 text-error'],
  // Nothing at all is sent; it reads as Blocked, and the popup says why.
  disable: ['Blocked', 'bg-error/10 text-error'],
} as const;
const SCOPE_TITLE: Record<Scope, string> = { account: 'Account status', business: 'Business status', display_name: 'Display name', phone: 'Number status' };
const SCOPES = Object.keys(SCOPE_TITLE) as Scope[];
const NEUTRAL = 'bg-surface-container text-on-surface-variant';

const dialog = el<HTMLDialogElement>('health-dialog');
let shown: NumberView | undefined;

/** One chip per scope in the Status section: OK, Limited or Blocked, and what it is behind. */
function renderChips(data: NumberView) {
  shown = data;
  for (const scope of SCOPES) {
    const status = data.health?.scopes[scope]?.status;
    const [text, classes] = !data.health ? (['Not checked', NEUTRAL] as const) : STATUS_CHIP[status ?? 'ok'];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rounded-full px-3 py-1 label-strong inline-flex items-center gap-1 ${classes}`;
    button.setAttribute('aria-haspopup', 'dialog');
    button.append(text);
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[16px]';
    icon.textContent = 'info';
    button.append(icon);
    button.addEventListener('click', () => openDialog(scope));
    el(`chip-${scope}`).replaceChildren(button);
  }
  renderRefresh(data);
}

/** When Meta was last asked, and whether the refresh can be used yet. */
function renderRefresh(data: NumberView) {
  const fetchedAt = data.metaFetchedAt;
  el('hd-checked').textContent = fetchedAt ? `Last checked ${new Date(fetchedAt).toLocaleString()}` : 'Never checked';
  const next = fetchedAt ? fetchedAt + REFRESH_MIN_INTERVAL_MS : 0;
  const wait = next > Date.now();
  el<HTMLButtonElement>('refresh-btn').disabled = wait;
  el('refresh-status').textContent = wait
    ? `Meta can be asked again at ${new Date(next).toLocaleTimeString()}.`
    : 'Meta is asked at most once in ten minutes.';
}

function paragraph(text: string, className = ''): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function openDialog(scope: Scope) {
  if (!shown) return;
  const health = shown.health;
  const status = health?.scopes[scope]?.status ?? 'ok';
  el('hd-title').textContent = `${SCOPE_TITLE[scope]}: ${health ? STATUS_CHIP[status][0] : 'not checked'}`;

  const body = el('hd-body');
  body.replaceChildren();
  const issues = health?.scopes[scope]?.issues ?? [];
  if (!health) {
    body.append(paragraph("Meta hasn't been asked about this number yet. Enter your API key and refresh."));
  } else if (!issues.length) {
    body.append(paragraph('Nothing needs your attention.'));
  }
  for (const issue of issues) {
    const item = document.createElement('div');
    item.className = 'flex flex-col gap-1';
    item.append(paragraph(issue.title, 'text-on-surface font-bold'), paragraph(issue.message));
    if (issue.link) {
      const link = document.createElement('a');
      link.href = issue.link;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'text-primary font-bold hover:underline w-fit';
      link.textContent = 'Open it →';
      item.append(link);
    }
    body.append(item);
  }
  if (scope === 'display_name' && shown.displayName?.name) {
    body.append(paragraph(`Current display name: ${shown.displayName.name} (${shown.displayName.status ?? 'status unknown'}).`));
  }
  // A new name can be requested unless one is already waiting for Meta's decision.
  const pending = /PENDING/i.test(shown.displayName?.requestedStatus ?? '');
  el('hd-name').classList.toggle('hidden', scope !== 'display_name' || pending);

  el('hd-status').textContent = '';
  dialog.showModal();
}

el('hd-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

/** Calls /numbers/<this number> with the key from the popup, which opens the stored token. */
async function callWithKey(method: 'GET' | 'PUT', path: string, body?: object) {
  const res = await fetch(`${functionsBase()}/numbers/${encodeURIComponent(phoneNumberId)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKeyInput.value.trim()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; metaError?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const hasKey = () => isValidApiKey(apiKeyInput.value.trim());

el('refresh-btn').addEventListener('click', async () => {
  const status = el('refresh-status');
  if (!hasKey()) {
    status.textContent = 'Enter your API key first.';
    return;
  }
  el<HTMLButtonElement>('refresh-btn').disabled = true;
  status.textContent = 'Asking Meta…';
  try {
    const result = await callWithKey('GET', '?refresh=true');
    if (result.metaError) throw new Error(result.metaError);
    location.reload();
  } catch (err) {
    status.textContent = errorMessage(err);
    el<HTMLButtonElement>('refresh-btn').disabled = false;
  }
});

el('hd-name-btn').addEventListener('click', async () => {
  const status = el('hd-status');
  const displayName = el<HTMLInputElement>('hd-name-input').value.trim();
  if (!hasKey() || displayName.length < 3) {
    status.textContent = 'Enter your API key and a name of at least 3 characters.';
    return;
  }
  el<HTMLButtonElement>('hd-name-btn').disabled = true;
  status.textContent = 'Sending the request to Meta…';
  try {
    await callWithKey('PUT', '/display-name', { displayName });
    location.reload();
  } catch (err) {
    status.textContent = `Not sent: ${errorMessage(err)}`;
    el<HTMLButtonElement>('hd-name-btn').disabled = false;
  }
});

// --- Notifications: what Meta told us, newest first ---------------------------------

const SEVERITY_DOT = { critical: 'bg-error', warning: 'bg-amber-500', info: 'bg-outline-variant' } as const;
let nextBefore: number | undefined;

async function renderNotifications(more = false) {
  el('notifications-card').classList.remove('hidden');
  const list = el('notifications-list');
  try {
    const page = await fetchNotifications(phoneNumberId, more ? nextBefore : undefined);
    if (!more) list.replaceChildren();
    for (const n of page.notifications) {
      const item = document.createElement('li');
      item.className = 'py-3 flex gap-3 items-start';
      const dot = document.createElement('span');
      dot.className = `mt-1.5 h-2.5 w-2.5 rounded-full flex-shrink-0 ${SEVERITY_DOT[n.severity]}`;
      const text = document.createElement('div');
      text.className = 'flex flex-col gap-0.5 min-w-0';
      text.append(paragraph(n.title, 'text-on-surface font-bold'), paragraph(n.message, 'text-on-surface-variant font-body-md text-sm'), paragraph(new Date(n.eventAt).toLocaleString(), 'label-muted'));
      item.append(dot, text);
      list.append(item);
    }
    nextBefore = page.nextBefore;
    el('notifications-more').classList.toggle('hidden', !page.nextBefore);
    el('notifications-empty').classList.toggle('hidden', list.children.length > 0);
  } catch {
    el('notifications-empty').textContent = 'Could not load the notifications.';
    el('notifications-empty').classList.remove('hidden');
  }
}
el('notifications-more').addEventListener('click', () => void renderNotifications(true));

// --- Override incoming message URL ------------------------------------------
el('chatbot-env').textContent =
  `WEBHOOK_VERIFY_TOKEN=${WEBHOOK_VERIFY_TOKEN}\nRELAY_BASE=${functionsBase()}/numbers\nWATOBOT_API_KEY=`;
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
    const res = await fetch(`${functionsBase()}/numbers/${encodeURIComponent(phoneNumberId)}/webhook`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ overrideCallbackUrl } satisfies Partial<SetWebhookRequest>),
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
    `curl -X POST '${base}/numbers/${phoneNumberId}/messages' \\`,
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
    `curl -X POST '${base}/numbers/${phoneNumberId}/messages' \\`,
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
    `curl -X POST '${base}/templatesBulk/${phoneNumberId}/migrate' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${JSON.stringify({ sourceWabaId: 'PREVIOUS_MESSAGING_ACCOUNT_ID' })}'`,
  ].join('\n');
  el<HTMLTextAreaElement>('tpl-import-command').value = [
    `curl -X POST '${base}/templatesBulk/${phoneNumberId}/import' \\`,
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
