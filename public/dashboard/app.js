import { auth, functionsBase, onAuthStateChanged, signInWithOtpToken } from '/assets/firebase-init.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { callAsUser, isValidApiKey, keyMatchesAccount } from '/assets/api-key.js';
import { NEW_KEY_NOTE, RESET_KEY_NOTE, saveFirstKey, showNewKey, signOutAfterNewKey } from '/assets/key-dialog.js';
import { db } from '/assets/firebase-init.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const phoneStepEl = document.getElementById('phone-step');
const codeStepEl = document.getElementById('code-step');
const phoneInput = document.getElementById('phone-input');
const codeInput = document.getElementById('code-input');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const loginStatus = document.getElementById('login-status');
const keyStepEl = document.getElementById('key-step');
const keyInput = document.getElementById('key-input');
const keyBtn = document.getElementById('key-btn');
const lostKeyBtn = document.getElementById('lost-key-btn');

let pendingPhone = null;
let pendingCode = null;

// Country-aware phone input: flag dropdown, auto-formatting, and validation
// against Google's libphonenumber data (loaded lazily via loadUtils).
const iti = window.intlTelInput(phoneInput, {
  initialCountry: 'in',
  loadUtils: () => import('https://cdn.jsdelivr.net/npm/intl-tel-input@29.5/dist/js/utils.js'),
});

sendOtpBtn.addEventListener('click', async () => {
  if (!phoneInput.value.trim()) {
    loginStatus.textContent = 'Enter your WhatsApp number first.';
    return;
  }
  if (!iti.isValidNumber()) {
    loginStatus.textContent = 'That doesn\'t look like a valid WhatsApp number — check the country and number.';
    return;
  }
  const phone = iti.getNumber(); // E.164, e.g. +919876543210
  sendOtpBtn.disabled = true;
  phoneInput.disabled = true;
  loginStatus.textContent = 'Sending code — this can take up to a minute…';
  try {
    const res = await fetch(`${functionsBase()}/sendOtp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const body = await res.json();
    if (!body.ok) {
      loginStatus.textContent = body.error || 'Failed to send code.';
      return;
    }
    pendingPhone = phone;
    phoneStepEl.classList.add('hidden');
    codeStepEl.classList.remove('hidden');
    loginStatus.textContent = 'Code sent — check WhatsApp.';
    codeInput.focus();
  } catch (err) {
    loginStatus.textContent = `Failed to send code: ${err.message}`;
  } finally {
    sendOtpBtn.disabled = false;
    phoneInput.disabled = false;
  }
});

// --- Sign in: OTP first, then the API key if the account has one ---------------
async function verify({ apiKey, resetApiKey } = {}) {
  const res = await fetch(`${functionsBase()}/verifyOtp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, code: pendingCode, apiKey, resetApiKey }),
  });
  const body = await res.json();

  if (body.needsApiKey) {
    codeStepEl.classList.add('hidden');
    keyStepEl.classList.remove('hidden');
    loginStatus.textContent = body.error || 'Enter your Watobot API key to continue.';
    keyInput.focus();
    return;
  }
  if (!body.ok) {
    loginStatus.textContent = body.error || 'Verification failed.';
    return;
  }

  if (resetApiKey) showNewKeyAfterReset = true;
  // The code is spent; the signed-in view takes over from onAuthStateChanged below.
  await signInWithOtpToken(body.token);
}

// Set after a lost-key reset at sign-in: the new key is shown right after signing in.
let showNewKeyAfterReset = false;

verifyOtpBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!code) {
    loginStatus.textContent = 'Enter the code you received.';
    return;
  }
  pendingCode = code;
  verifyOtpBtn.disabled = true;
  loginStatus.textContent = 'Verifying…';
  try {
    await verify();
  } catch (err) {
    loginStatus.textContent = `Verification failed: ${err.message}`;
  } finally {
    verifyOtpBtn.disabled = false;
  }
});

keyBtn.addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (!isValidApiKey(apiKey)) {
    loginStatus.textContent = 'An API key is 64 characters of 0-9 and a-f.';
    return;
  }
  keyBtn.disabled = true;
  loginStatus.textContent = 'Signing in…';
  try {
    await verify({ apiKey });
  } catch (err) {
    loginStatus.textContent = `Sign in failed: ${err.message}`;
  } finally {
    keyBtn.disabled = false;
  }
});

lostKeyBtn.addEventListener('click', async () => {
  const ok = confirm(
    'Your onboarded WABAs will be useless.\n\n' +
      'Without your API key we cannot open the access tokens we hold for your numbers, so we have to delete them. ' +
      'Your numbers stay in your list, but each one must be onboarded again before it can send.\n\n' +
      "You'll then get a new API key to note down. Continue?",
  );
  if (!ok) return;
  loginStatus.textContent = 'Resetting…';
  try {
    await verify({ resetApiKey: true });
  } catch (err) {
    loginStatus.textContent = `Reset failed: ${err.message}`;
  }
});

// --- Rotate and reset (signed in) -------------------------------------------------
const rotateBtn = document.getElementById('rotate-btn');
const rotateStatus = document.getElementById('rotate-status');
rotateBtn.addEventListener('click', async () => {
  const oldApiKey = document.getElementById('rotate-old').value.trim();
  if (!isValidApiKey(oldApiKey)) {
    rotateStatus.textContent = 'Enter your current API key first.';
    return;
  }
  if (!(await keyMatchesAccount(db, getDoc, doc, auth.currentUser.uid, oldApiKey))) {
    rotateStatus.textContent = 'That is not the current key for this account.';
    return;
  }
  rotateStatus.textContent = '';
  showNewKey({
    required: false,
    note: NEW_KEY_NOTE,
    save: (newApiKey) => callAsUser(auth, `${functionsBase()}/rotateKey`, { oldApiKey, newApiKey }),
    afterSave: signOutAfterNewKey,
  });
});

document.getElementById('reset-key-btn').addEventListener('click', async () => {
  const ok = confirm(
    'Your onboarded WABAs will be useless.\n\n' +
      'Only do this if you lost your key. We will delete the access tokens we hold for your numbers, and each number must be onboarded again before it can send. Continue?',
  );
  if (!ok) return;
  try {
    await callAsUser(auth, `${functionsBase()}/resetKey`, {});
    showNewKey({ required: true, note: NEW_KEY_NOTE, save: saveFirstKey, afterSave: signOutAfterNewKey });
  } catch (err) {
    rotateStatus.textContent = `Reset failed: ${err.message}`;
  }
});

// --- The signed-in dashboard --------------------------------------------------------
function renderCards(wabas) {
  const cards = document.getElementById('waba-cards');
  cards.replaceChildren();
  document.getElementById('waba-cards-empty').classList.toggle('hidden', wabas.length > 0);

  for (const waba of wabas) {
    const card = document.createElement('a');
    card.href = `/waba.html?id=${encodeURIComponent(waba.id)}`;
    card.className = 'card p-6 hover:shadow-md transition-all flex flex-col gap-1';

    const row = document.createElement('div');
    row.className = 'flex justify-between items-center gap-4';
    const title = document.createElement('p');
    title.className = 'section-title text-on-surface break-all';
    title.textContent = `Phone number ID ${waba.id}`;
    const status = document.createElement('span');
    status.className = 'label-muted whitespace-nowrap';
    // A number with no stored token (after a key reset) can't send until onboarded again.
    status.textContent = !waba.encAccessToken ? 'Onboard again' : waba.overrideUrl ? 'Incoming URL set' : 'Setup incomplete';
    status.classList.add(waba.encAccessToken && waba.overrideUrl ? 'text-primary' : 'text-on-surface-variant');
    row.append(title, status);
    card.append(row);

    if (waba.wabaId) {
      const w = document.createElement('p');
      w.className = 'text-on-surface-variant font-body-md text-sm';
      w.textContent = `WABA ${waba.wabaId}`;
      card.append(w);
    }
    cards.append(card);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    signedOutEl.classList.add('hidden');
    signedInEl.classList.remove('hidden');
    renderCards(await fillSidebar(user.uid));
    if (showNewKeyAfterReset) {
      showNewKeyAfterReset = false;
      showNewKey({
        required: true,
        note: RESET_KEY_NOTE,
        save: saveFirstKey,
      });
    }
  } else {
    signedInEl.classList.add('hidden');
    signedOutEl.classList.remove('hidden');
    pendingPhone = null;
    pendingCode = null;
    codeStepEl.classList.add('hidden');
    keyStepEl.classList.add('hidden');
    phoneStepEl.classList.remove('hidden');
    iti.setNumber('');
    codeInput.value = '';
    keyInput.value = '';
    loginStatus.textContent = '';
  }
});
