import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { META_APP_ID, META_CONFIG_ID } from '/assets/app-config.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Same date-key algorithm as functions/src/relayMessage.ts, duplicated here
// (small + pure) so usage lookups match the keys the relay actually wrote.
function dailyKey(d) {
  return d.toISOString().slice(0, 10);
}
function monthlyKey(d) {
  return d.toISOString().slice(0, 7);
}
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function relativeTime(atMs) {
  const seconds = Math.round((Date.now() - atMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// --- Wizard chrome (pills/panels) ------------------------------------------
let currentStep = 1;
let maxUnlockedStep = 1;
const stepPanels = document.querySelectorAll('[data-step-panel]');
const stepPills = document.querySelectorAll('.step-pill');

function renderWizard() {
  stepPanels.forEach((panel) => {
    panel.classList.toggle('hidden', Number(panel.dataset.stepPanel) !== currentStep);
  });
  stepPills.forEach((pill) => {
    const n = Number(pill.dataset.step);
    pill.classList.remove('bg-primary-container', 'text-on-primary-container', 'bg-primary', 'text-on-primary', 'bg-surface-container-low', 'text-on-surface-variant', 'cursor-not-allowed', 'cursor-pointer');
    if (n === currentStep) {
      pill.classList.add('bg-primary-container', 'text-on-primary-container');
    } else if (n < maxUnlockedStep) {
      pill.classList.add('bg-primary', 'text-on-primary', 'cursor-pointer');
    } else if (n <= maxUnlockedStep) {
      pill.classList.add('bg-surface-container-low', 'text-on-surface-variant', 'cursor-pointer');
    } else {
      pill.classList.add('bg-surface-container-low', 'text-on-surface-variant', 'cursor-not-allowed');
    }
    pill.disabled = n > maxUnlockedStep;
  });
}
function goToStep(n) {
  if (n > maxUnlockedStep) return;
  currentStep = n;
  renderWizard();
}
function advanceTo(n) {
  maxUnlockedStep = Math.max(maxUnlockedStep, n);
  currentStep = n;
  renderWizard();
}
stepPills.forEach((pill) => pill.addEventListener('click', () => goToStep(Number(pill.dataset.step))));
document.querySelectorAll('.step-back').forEach((btn) => btn.addEventListener('click', () => goToStep(Number(btn.dataset.backTo))));

// --- State -------------------------------------------------------------
const params = new URLSearchParams(location.search);
let phoneNumberId = params.get('id');
let wabaId = null;
let signupCode = null;

const onboardingStatus = document.getElementById('onboarding-status');
const loginBtn = document.getElementById('login-btn');
const step1Next = document.getElementById('step1-next');
const overrideUrlInput = document.getElementById('override-url');
const testEndpointBtn = document.getElementById('test-endpoint-btn');
const endpointCheckStatus = document.getElementById('endpoint-check-status');
const step2Next = document.getElementById('step2-next');
const fetchLastMessageBtn = document.getElementById('fetch-last-message-btn');
const lastMessageStatus = document.getElementById('last-message-status');
const step3Next = document.getElementById('step3-next');

function renderRelaySnippet() {
  document.getElementById('relay-snippet').textContent =
    `POST /relayMessage/${phoneNumberId ?? '<phone-number-id>'}/messages\n` +
    `Authorization: Bearer <your WhatsApp access token>\n` +
    `Content-Type: application/json\n\n` +
    `{\n  "messaging_product": "whatsapp",\n  "to": "<recipient>",\n  "type": "text",\n  "text": { "body": "Hello!" }\n}`;
}

async function loadUsageStats() {
  const snap = await getDoc(doc(db, 'wabas', phoneNumberId));
  const usage = snap.data()?.usage ?? {};
  const now = new Date();
  document.getElementById('usage-today').textContent = usage.daily?.[dailyKey(now)] ?? 0;
  document.getElementById('usage-week').textContent = usage.weekly?.[isoWeekKey(now)] ?? 0;
  document.getElementById('usage-month').textContent = usage.monthly?.[monthlyKey(now)] ?? 0;
}

// --- Step 1: Embedded Signup (fresh onboarding only) ------------------
async function initEmbeddedSignup() {
  window.fbAsyncInit = function () {
    FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: 'v21.0' });
    onboardingStatus.textContent = 'Ready.';
    loginBtn.disabled = false;
  };
  const script = document.createElement('script');
  script.src = 'https://connect.facebook.net/en_US/sdk.js';
  script.async = true;
  document.body.appendChild(script);

  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
        wabaId = data.data.waba_id;
        phoneNumberId = data.data.phone_number_id;
        onboardingStatus.textContent = `Signup finished. WABA ${wabaId}, phone number ${phoneNumberId}.`;
        maybeCompleteStep1();
      }
    } catch {
      // Not a JSON message we care about.
    }
  });

  loginBtn.addEventListener('click', () => {
    FB.login(
      (response) => {
        if (response.authResponse?.code) {
          signupCode = response.authResponse.code;
          onboardingStatus.textContent = 'Got signup code, waiting for WABA details…';
          maybeCompleteStep1();
        } else {
          onboardingStatus.textContent = 'Login cancelled or failed.';
        }
      },
      {
        config_id: META_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  });
}
function maybeCompleteStep1() {
  const ready = Boolean(signupCode && wabaId && phoneNumberId);
  step1Next.disabled = !ready;
  if (ready) {
    history.replaceState(null, '', `/dashboard/waba.html?id=${encodeURIComponent(phoneNumberId)}`);
    renderRelaySnippet();
    advanceTo(2);
  }
}
step1Next.addEventListener('click', () => advanceTo(2));

// --- Step 2: incoming-message endpoint ---------------------------------
testEndpointBtn.addEventListener('click', async () => {
  const url = overrideUrlInput.value.trim();
  if (!url) {
    endpointCheckStatus.textContent = 'Enter your endpoint URL first.';
    return;
  }

  const idToken = await auth.currentUser.getIdToken();
  endpointCheckStatus.textContent = 'Testing endpoint…';
  const checkRes = await fetch(`${functionsBase()}/checkEndpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ url }),
  });
  const check = await checkRes.json();
  if (!check.ok) {
    endpointCheckStatus.textContent = `❌ ${check.error}`;
    return;
  }

  endpointCheckStatus.textContent = 'Endpoint verified. Activating coexistence…';
  const completeRes = await fetch(`${functionsBase()}/completeOnboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ code: signupCode, wabaId, phoneNumberId, overrideCallbackUrl: url }),
  });
  const complete = await completeRes.json();
  if (!completeRes.ok) {
    endpointCheckStatus.textContent = `❌ ${complete.error || 'Failed to activate coexistence.'}`;
    return;
  }

  if (complete.accessToken) {
    // Kept only in the DOM for this page view — never written to Firestore or storage.
    document.getElementById('token-value').value = complete.accessToken;
    document.getElementById('token-box').classList.remove('hidden');
  }

  await setDoc(
    doc(db, 'wabas', phoneNumberId),
    { ownerUid: auth.currentUser.uid, wabaId, overrideUrl: url, activatedAt: Date.now() },
    { merge: true },
  );

  endpointCheckStatus.textContent =
    "✅ Verified and coexistence activated. Check the phone's WhatsApp Business App — it should now show as connected.";
  document.getElementById('pending-endpoint').textContent = url;
  renderRelaySnippet();
  step2Next.disabled = false;
  advanceTo(3);
});
step2Next.addEventListener('click', () => advanceTo(3));

document.getElementById('copy-token-btn').addEventListener('click', async () => {
  const input = document.getElementById('token-value');
  await navigator.clipboard.writeText(input.value);
  document.getElementById('copy-token-btn').textContent = 'Copied';
});

// --- Step 3: relay usage -------------------------------------------------
fetchLastMessageBtn.addEventListener('click', async () => {
  lastMessageStatus.textContent = 'Checking…';
  const snap = await getDoc(doc(db, 'wabas', phoneNumberId));
  const last = snap.data()?.lastRelayCall;
  if (!last) {
    lastMessageStatus.textContent = 'No messages sent yet via the relay for this number — update your app to call it, then fetch again.';
    return;
  }
  lastMessageStatus.textContent = `${last.ok ? '✅ Success' : `❌ Failed (HTTP ${last.statusCode})`} — ${relativeTime(last.at)}`;
  await loadUsageStats();
  advanceTo(4);
});
step3Next.addEventListener('click', () => advanceTo(4));

// --- Boot ---------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }

  if (phoneNumberId) {
    // Resuming an existing WABA — check doc existence only (per design,
    // that's treated as "step 1 connected"); further steps resume based on
    // which fields are already present.
    const snap = await getDoc(doc(db, 'wabas', phoneNumberId));
    const data = snap.data();
    if (data) {
      wabaId = data.wabaId;
      onboardingStatus.textContent = 'Connected.';
      renderRelaySnippet();

      if (data.overrideUrl && data.activatedAt) {
        overrideUrlInput.value = data.overrideUrl;
        document.getElementById('pending-endpoint').textContent = data.overrideUrl;
        const lastSnap = await getDoc(doc(db, 'wabas', phoneNumberId));
        if (lastSnap.data()?.lastRelayCall) {
          await loadUsageStats();
          advanceTo(4);
        } else {
          advanceTo(3);
        }
      } else {
        advanceTo(2);
      }
      return;
    }
  }

  // Fresh onboarding.
  renderWizard();
  initEmbeddedSignup();
});
