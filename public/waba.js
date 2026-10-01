import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { fillSidebar, hideSidebar } from '/assets/waba-sidebar.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const phoneNumberId = new URLSearchParams(location.search).get('id');

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

// Reads wabas/{id} only when someone is signed in; the rules let only the
// owner read it. Anyone else (or a missing doc) simply gets no counts and no
// prefill, and the page works the same for testing.
async function loadRecord() {
  if (!auth.currentUser || !phoneNumberId) return;
  let data;
  try {
    data = (await getDoc(doc(db, 'wabas', phoneNumberId))).data();
  } catch {
    return;
  }
  if (!data) return;

  if (data.wabaId && !$('ov-waba-id').value) $('ov-waba-id').value = data.wabaId;
  if (data.overrideUrl && !$('ov-url').value) $('ov-url').value = data.overrideUrl;

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
$('ov-btn').addEventListener('click', async () => {
  const accessToken = $('ov-token').value.trim();
  const wabaId = $('ov-waba-id').value.trim();
  const overrideCallbackUrl = $('ov-url').value.trim();
  const status = $('ov-status');
  if (!accessToken || !wabaId || !overrideCallbackUrl) {
    status.textContent = 'Fill in the access token, WABA ID and your URL.';
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
        'Done: incoming messages now go to your URL. Sign in on the Dashboard to keep this number in your list.';
      return;
    }
    try {
      await setDoc(
        doc(db, 'wabas', phoneNumberId),
        { ownerUid: auth.currentUser.uid, wabaId, overrideUrl: overrideCallbackUrl, activatedAt: Date.now() },
        { merge: true },
      );
      status.textContent = 'Done: incoming messages now go to your URL, and it is saved to your account.';
      fillSidebar(auth.currentUser.uid, phoneNumberId);
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
$('out-btn').addEventListener('click', async () => {
  const token = $('out-token').value.trim();
  const result = $('out-result');
  if (!token) {
    result.textContent = 'Paste your access token first.';
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
if (!phoneNumberId) {
  $('no-id').classList.remove('hidden');
} else {
  $('number-id').textContent = `Phone number ID: ${phoneNumberId}`;
  $('endpoint-line').textContent = `POST ${functionsBase()}/relayMessage/${phoneNumberId}/messages`;
  $('out-body').value = JSON.stringify(BODY_TEMPLATE, null, 2);
  $('sections').classList.remove('hidden');
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    fillSidebar(user.uid, phoneNumberId);
    loadRecord();
  } else {
    hideSidebar();
  }
});
