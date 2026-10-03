import { auth, db, functionsBase, onAuthStateChanged } from '/assets/firebase-init.js';
import { META_APP_ID, META_CONFIG_ID } from '/assets/app-config.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { FIRST_KEY_NOTE, NEW_KEY_NOTE, saveFirstKey, showNewKey, signOutAfterNewKey } from '/assets/key-dialog.js';
import { isValidApiKey } from '/assets/api-key.js';
import { callAsUser, keyMatchesAccount, resetKey } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import type { ExchangeCodeRequest, UserDoc } from '../../../functions/src/helpers/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const fetchBtn = el<HTMLButtonElement>('fetch-btn');
const status = el('onboarding-status');
const keyInput = el<HTMLInputElement>('key-input');

let sdkReady = false;
let keyVerified = false;
let signupCode: string | null = null;
let wabaId: string | null = null;
let phoneNumberId: string | null = null;
let exchanging = false;

function refreshButton() {
  fetchBtn.disabled = !(sdkReady && keyVerified);
  if (sdkReady && keyVerified) status.textContent = 'Ready.';
}

// The key is checked here, in the browser, as it is typed, against the hash on the
// user's own record, so a wrong key is caught before Meta's popup opens. (The popup
// itself must open straight from a click.) The server checks the key again when the
// token is stored, which is the check that counts.
async function checkKey() {
  const apiKey = keyInput.value.trim();
  keyVerified = false;
  if (!apiKey) {
    status.textContent = 'Enter your API key to continue.';
  } else if (!isValidApiKey(apiKey)) {
    status.textContent = 'An API key is 64 characters of 0-9 and a-f.';
  } else if (await keyMatchesAccount(auth.currentUser!.uid, apiKey)) {
    keyVerified = true;
  } else {
    status.textContent = 'That is not the key for this account.';
  }
  refreshButton();
}

keyInput.addEventListener('input', checkKey);

el('lost-key-btn').addEventListener('click', async () => {
  const ok = confirm(
    'Your onboarded WABAs will be useless.\n\n' +
      'Without your API key we cannot open the access tokens we hold for your numbers, so we have to delete them. ' +
      'Each number must be onboarded again before it can send.\n\n' +
      "You'll then get a new API key to note down. Continue?",
  );
  if (!ok) return;
  try {
    await resetKey(auth.currentUser!.uid);
    showNewKey({ required: true, note: NEW_KEY_NOTE, save: saveFirstKey, afterSave: signOutAfterNewKey });
  } catch (err) {
    status.textContent = `Reset failed: ${errorMessage(err)}`;
  }
});

el('create-key-btn').addEventListener('click', () =>
  showNewKey({ required: true, note: FIRST_KEY_NOTE, save: saveFirstKey, afterSave: signOutAfterNewKey }),
);

// Both halves of Embedded Signup must arrive: the code (from FB.login's callback)
// and the WABA and phone number ids (from a window message).
async function maybeFinish() {
  if (exchanging || !(signupCode && wabaId && phoneNumberId)) return;
  exchanging = true;
  status.textContent = 'Connecting your number…';
  try {
    await callAsUser(`${functionsBase()}/exchangeCode`, {
      code: signupCode,
      wabaId,
      phoneNumberId,
      apiKey: keyInput.value.trim(),
    } satisfies ExchangeCodeRequest);
    location.href = `/dashboard/waba/?id=${encodeURIComponent(phoneNumberId)}`;
  } catch (err) {
    status.textContent = `Failed: ${errorMessage(err)}`;
    exchanging = false;
  }
}

function initEmbeddedSignup() {
  window.fbAsyncInit = function () {
    FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: 'v21.0' });
    sdkReady = true;
    if (!keyVerified) status.textContent = 'Enter your API key to continue.';
    refreshButton();
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

let started = false;
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid);
  if (started) return;
  started = true;

  // An account with no API key yet creates one here, before its first onboarding.
  const hasKey = Boolean(((await getDoc(doc(db, 'users', user.uid))).data() as UserDoc | undefined)?.apiKeyHash);
  if (!hasKey) {
    el('create-key-card').classList.remove('hidden');
    status.textContent = '';
    return;
  }

  el('intro-card').classList.remove('hidden');
  initEmbeddedSignup();
});
