import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { isValidApiKey } from '/assets/api-key.js';
import '/assets/nav-auth.js';
import { el, errorMessage } from '/assets/dom.js';
import type { PhoneNumberDoc, SetWebhookRequest } from '../../../functions/src/helpers/types';
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

// One tile: the current count big, the previous window under it with the change, and a limit
// when there is one.
function tile(label: string, current: number, previous: number, limit?: number): HTMLElement {
  const box = document.createElement('div');
  box.className = 'rounded-lg border border-outline-variant p-3 text-center';
  const over = limit !== undefined && current >= limit;
  if (over) box.classList.add('border-error');

  const name = document.createElement('p');
  name.className = 'label-muted';
  name.textContent = label;

  const big = document.createElement('p');
  big.className = `font-headline-md text-headline-md ${over ? 'text-error' : 'text-on-surface'}`;
  big.textContent = limit === undefined ? current.toLocaleString() : `${current.toLocaleString()} / ${limit.toLocaleString()}`;

  const small = document.createElement('p');
  small.className = 'text-on-surface-variant font-body-md text-sm';
  let change = '';
  if (previous > 0) {
    const pct = Math.round(((current - previous) / previous) * 100);
    change = ` · ${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
  }
  small.textContent = `prev ${previous.toLocaleString()}${change}`;

  box.append(name, big, small);
  return box;
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

  const windows = view(data.rateState, effectiveConfig(data.rateLimits), now.getTime());
  el('limit-tiles').replaceChildren(
    tile('This minute', windows.minute.current, windows.minute.previous, windows.minute.limit),
    tile('This hour', windows.hour.current, windows.hour.previous, windows.hour.limit),
    tile('Today', windows.day.current, windows.day.previous, windows.day.limit),
  );
  el('stats').classList.remove('hidden');
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

  if (data.wabaId) el('waba-id-line').textContent = `WABA ID: ${data.wabaId}`;
  if (data.overrideUrl && !overrideUrl.value) overrideUrl.value = data.overrideUrl;

  if (data.displayPhoneNumber) el('number-id-line').textContent = `Phone number: ${data.displayPhoneNumber} · ID ${phoneNumberId}`;
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

  // Only for a brand-new number (not coexistence): Meta needs it registered before it can send.
  const register = JSON.stringify({ phoneNumberId, apiKey: key, pin: 'YOUR_6_DIGIT_PIN' });
  el<HTMLTextAreaElement>('register-command').value = [
    `curl -X POST '${base}/registerNumber' \\`,
    `  ${json} \\`,
    `  -d '${register}'`,
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
  el<HTMLTextAreaElement>('templates-command').value = [
    '# List templates (each has an id)',
    `curl '${base}/templates/${phoneNumberId}' \\`,
    `  ${auth}`,
    '',
    '# Create a template',
    `curl -X POST '${base}/templates/${phoneNumberId}' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${create}'`,
    '',
    '# Edit a template (use its id from the list)',
    `curl -X POST '${base}/templates/${phoneNumberId}/TEMPLATE_ID' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${edit}'`,
    '',
    '# Delete a template by name',
    `curl -X DELETE '${base}/templates/${phoneNumberId}?name=order_update' \\`,
    `  ${auth}`,
  ].join('\n');
}
apiKeyInput.addEventListener('input', renderCommands);

for (const [button, box] of [
  ['copy-send-btn', 'send-command'],
  ['copy-templates-btn', 'templates-command'],
  ['copy-register-btn', 'register-command'],
]) {
  el(button).addEventListener('click', async () => {
    await navigator.clipboard.writeText(el<HTMLTextAreaElement>(box).value);
    el(button).textContent = 'Copied';
  });
}

// --- Boot ---------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid, phoneNumberId);
  el('number-id-line').textContent = `Phone number ID: ${phoneNumberId}`;
  // What the buttons and commands do is authorised by the API key, not by this sign-in, so
  // the sections show either way.
  renderCommands();
  el('key-card').classList.remove('hidden');
  el('sections').classList.remove('hidden');
  if (!(await loadRecord())) el('not-found').classList.remove('hidden');
});
