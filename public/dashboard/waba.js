import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { META_APP_ID, META_CONFIG_ID } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const fetchBtn = document.getElementById('fetch-btn');
const status = document.getElementById('onboarding-status');
const tokenCard = document.getElementById('token-card');

let signupCode = null;
let wabaId = null;
let phoneNumberId = null;
let exchanging = false;

// Both halves of Embedded Signup must arrive: the code (from FB.login's
// callback) and the WABA and phone number ids (from a window message).
async function maybeFinish() {
  if (exchanging || !(signupCode && wabaId && phoneNumberId)) return;
  exchanging = true;
  status.textContent = 'Getting your access token…';

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${functionsBase()}/exchangeCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ code: signupCode }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Could not get an access token.');

    // Shown once, kept only in this page. Never written to Firestore or storage.
    document.getElementById('token-value').value = body.accessToken;
    document.getElementById('intro-card').classList.add('hidden');
    tokenCard.classList.remove('hidden');

    const connected = document.getElementById('connected-status');
    try {
      await setDoc(
        doc(db, 'wabas', phoneNumberId),
        { ownerUid: auth.currentUser.uid, wabaId },
        { merge: true },
      );
      connected.textContent = `Connected: WABA ${wabaId}, phone number ID ${phoneNumberId}.`;
      fillSidebar(auth.currentUser.uid);
    } catch (err) {
      connected.textContent = `Connected, but we couldn't save it to your dashboard (${err.message}). WABA ${wabaId}, phone number ID ${phoneNumberId}.`;
    }
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    exchanging = false;
  }
}

function initEmbeddedSignup() {
  window.fbAsyncInit = function () {
    FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: 'v21.0' });
    status.textContent = 'Ready.';
    fetchBtn.disabled = false;
  };
  const script = document.createElement('script');
  script.src = 'https://connect.facebook.net/en_US/sdk.js';
  script.async = true;
  document.body.appendChild(script);

  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (
        data.type === 'WA_EMBEDDED_SIGNUP' &&
        (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')
      ) {
        wabaId = data.data.waba_id;
        phoneNumberId = data.data.phone_number_id;
        status.textContent = 'Signup finished, waiting for the code…';
        maybeFinish();
      }
    } catch {
      // Not a JSON message we care about.
    }
  });

  fetchBtn.addEventListener('click', () => {
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

document.getElementById('copy-token-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('token-value').value);
  document.getElementById('copy-token-btn').textContent = 'Copied';
});

document.getElementById('saved-btn').addEventListener('click', () => {
  location.href = `/waba.html?id=${encodeURIComponent(phoneNumberId)}`;
});

let started = false;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid);
  if (!started) {
    started = true;
    initEmbeddedSignup();
  }
});
