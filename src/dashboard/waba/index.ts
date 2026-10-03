import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { isValidApiKey } from '/assets/api-key.js';
import '/assets/nav-auth.js';
import { el, errorMessage } from '/assets/dom.js';
import type { PhoneNumberDoc, SetWebhookRequest } from '../../../functions/src/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// The page for one number, identified by ?id= in the URL (its phone number ID). Signed-in
// only: signed-out visitors are sent to the Dashboard's sign-in. What it does to the number
// is authorised by the Watobot API key typed at the top, and it never writes to Firestore.
const phoneNumberId = new URLSearchParams(location.search).get('id') ?? '';

const apiKeyInput = el<HTMLInputElement>('api-key');
const overrideUrl = el<HTMLInputElement>('ov-url');
const overrideBtn = el<HTMLButtonElement>('ov-btn');
const overrideStatus = el('ov-status');

// Same date-key algorithm as functions/src/relayMessage.ts, duplicated here
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

// The rules let just the owner read phoneNumbers/{phoneNumberId}. Returns false if the
// number isn't in this account.
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

  const usage = data.usage;
  if (usage) {
    const now = new Date();
    el('usage-today').textContent = String(usage.daily?.[dailyKey(now)] ?? 0);
    el('usage-week').textContent = String(usage.weekly?.[isoWeekKey(now)] ?? 0);
    el('usage-month').textContent = String(usage.monthly?.[monthlyKey(now)] ?? 0);
    el('counts-card').classList.remove('hidden');
  }
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

  const message = JSON.stringify({
    messaging_product: 'whatsapp',
    to: 'RECIPIENT_PHONE_NUMBER',
    type: 'text',
    text: { body: 'Hello from Watobot' },
  });
  el<HTMLTextAreaElement>('send-command').value = [
    `curl -X POST '${base}/relayMessage/${phoneNumberId}/messages' \\`,
    `  ${auth} \\`,
    `  ${json} \\`,
    `  -d '${message}'`,
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
  if (await loadRecord()) {
    renderCommands();
    el('key-card').classList.remove('hidden');
    el('sections').classList.remove('hidden');
  } else {
    el('not-found').classList.remove('hidden');
  }
});
