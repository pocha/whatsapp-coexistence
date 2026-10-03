import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { WEBHOOK_VERIFY_TOKEN } from '/assets/app-config.js';
import { fillSidebar, hideSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const GRAPH = 'https://graph.facebook.com/v21.0';
// The page is about one WABA, identified by ?id= in the URL.
const wabaId = new URLSearchParams(location.search).get('id');

// Same date-key algorithm as functions/src/relayMessage.ts, duplicated here
// (small and pure) so usage lookups match the keys the relay wrote.
const dailyKey = (d) => d.toISOString().slice(0, 10);
const monthlyKey = (d) => d.toISOString().slice(0, 7);
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const BODY_TEMPLATE = {
  messaging_product: 'whatsapp',
  to: '',
  type: 'text',
  text: { body: '' },
};

function updateEndpointLine() {
  const phone = $('out-phone').value.trim() || '<phone-number-id>';
  $('endpoint-line').textContent = `POST ${functionsBase()}/relayMessage/${phone}/messages`;
}

// Reads wabas/{id} only when someone is signed in; the rules let only the
// owner read it. Anyone else (or a missing record) simply gets no counts and no
// prefill, and the page works the same for testing.
async function loadRecord() {
  if (!auth.currentUser || !wabaId) return;
  let data;
  try {
    data = (await getDoc(doc(db, 'wabas', wabaId))).data();
  } catch {
    return;
  }
  if (!data) return;

  if (data.overrideUrl && !$('ov-url').value) $('ov-url').value = data.overrideUrl;
  if (data.phoneNumberId && !$('out-phone').value) {
    $('out-phone').value = data.phoneNumberId;
    updateEndpointLine();
  }

  const usage = data.usage;
  if (usage) {
    const now = new Date();
    $('usage-today').textContent = usage.daily?.[dailyKey(now)] ?? 0;
    $('usage-week').textContent = usage.weekly?.[isoWeekKey(now)] ?? 0;
    $('usage-month').textContent = usage.monthly?.[monthlyKey(now)] ?? 0;
    $('counts-card').classList.remove('hidden');
  }
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

// --- Override incoming message URL ------------------------------------------
$('chatbot-env').textContent =
  `WEBHOOK_VERIFY_TOKEN=${WEBHOOK_VERIFY_TOKEN}\nRELAY_BASE=${functionsBase()}/relayMessage\nACCESS_TOKEN=`;
$('copy-env-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('chatbot-env').textContent);
  $('copy-env-btn').textContent = 'Copied';
});

$('ov-btn').addEventListener('click', async () => {
  const accessToken = $('ov-token').value.trim();
  const overrideCallbackUrl = $('ov-url').value.trim();
  const status = $('ov-status');
  if (!accessToken || !overrideCallbackUrl) {
    status.textContent = 'Fill in the access token and your URL.';
    return;
  }

  $('ov-btn').disabled = true;
  status.textContent = 'Checking your URL and updating WhatsApp…';
  try {
    const { res, body } = await postJson(`${functionsBase()}/setWebhook`, null, {
      wabaId,
      accessToken,
      overrideCallbackUrl,
    });
    if (!res.ok || !body.ok) {
      status.textContent = `Not saved: ${body.error || `HTTP ${res.status}`}`;
      return;
    }

    // Only record it once the function has succeeded, and only for a signed-in user.
    if (!auth.currentUser) {
      status.textContent =
        'Done: incoming messages now go to your URL. Sign in on the Dashboard to keep this WABA in your list.';
      return;
    }
    try {
      const record = { ownerUid: auth.currentUser.uid, wabaId, overrideUrl: overrideCallbackUrl, activatedAt: Date.now() };
      const phoneNumberId = $('out-phone').value.trim();
      if (phoneNumberId) record.phoneNumberId = phoneNumberId;
      await setDoc(doc(db, 'wabas', wabaId), record, { merge: true });
      status.textContent = 'Done: incoming messages now go to your URL, and it is saved to your account.';
      fillSidebar(auth.currentUser.uid, wabaId);
    } catch (err) {
      status.textContent = `Done with WhatsApp, but we couldn't save it to your account (${err.message}).`;
    }
  } catch (err) {
    status.textContent = `Request failed: ${err.message}`;
  } finally {
    $('ov-btn').disabled = false;
  }
});

// --- Test outgoing message ----------------------------------------------------
$('out-phone').addEventListener('input', updateEndpointLine);

$('lookup-btn').addEventListener('click', async () => {
  const token = $('out-token').value.trim();
  const status = $('lookup-status');
  if (!token) {
    status.textContent = 'Paste your access token first.';
    return;
  }
  $('lookup-btn').disabled = true;
  status.textContent = 'Looking up…';
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = `Look up failed: ${body.error?.message || `HTTP ${res.status}`}`;
      return;
    }
    const numbers = body.data ?? [];
    const options = $('out-phone-options');
    options.replaceChildren();
    for (const n of numbers) {
      const option = document.createElement('option');
      option.value = n.id;
      option.label = n.display_phone_number;
      options.append(option);
    }
    if (numbers.length === 1) {
      $('out-phone').value = numbers[0].id;
      updateEndpointLine();
      status.textContent = `Found ${numbers[0].display_phone_number}.`;
    } else {
      status.textContent = numbers.length
        ? `Found ${numbers.length} numbers. Click the field to choose one.`
        : 'No phone numbers found on this WABA.';
    }
  } catch (err) {
    status.textContent = `Look up failed: ${err.message}`;
  } finally {
    $('lookup-btn').disabled = false;
  }
});

$('out-btn').addEventListener('click', async () => {
  const token = $('out-token').value.trim();
  const phoneNumberId = $('out-phone').value.trim();
  const result = $('out-result');
  if (!token || !phoneNumberId) {
    result.textContent = 'Fill in the access token and the phone number ID.';
    return;
  }
  let message;
  try {
    message = JSON.parse($('out-body').value);
  } catch {
    result.textContent = 'The request body is not valid JSON.';
    return;
  }

  $('out-btn').disabled = true;
  result.textContent = 'Sending…';
  try {
    const { res, body } = await postJson(
      `${functionsBase()}/relayMessage/${encodeURIComponent(phoneNumberId)}/messages`,
      token,
      message,
    );
    result.textContent = `HTTP ${res.status}\n${JSON.stringify(body, null, 2)}`;
    if (res.ok) loadRecord();
  } catch (err) {
    result.textContent = `Request failed: ${err.message}`;
  } finally {
    $('out-btn').disabled = false;
  }
});

// --- Boot ---------------------------------------------------------------------
if (!wabaId) {
  $('no-id').classList.remove('hidden');
} else {
  $('waba-id-line').textContent = `WABA ID: ${wabaId}`;
  $('out-body').value = JSON.stringify(BODY_TEMPLATE, null, 2);
  updateEndpointLine();
  $('sections').classList.remove('hidden');
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    fillSidebar(user.uid, wabaId);
    loadRecord();
  } else {
    hideSidebar();
  }
});
