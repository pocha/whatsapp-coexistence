import { auth, functionsBase, onAuthStateChanged, signInWithOtpToken } from '/assets/firebase-init.js';
import '/assets/nav-auth.js';
import { isValidApiKey } from '/assets/api-key.js';
import { el, errorMessage } from '/assets/dom.js';
import type { VerifyOtpRequest, VerifyOtpResponse, SendOtpResponse } from '../../functions/src/helpers/types';
import { RESET_KEY_NOTE, saveFirstKey, showNewKey } from '/assets/key-dialog.js';

const phoneStepEl = el('phone-step');
const codeStepEl = el('code-step');
const phoneInput = el<HTMLInputElement>('phone-input');
const codeInput = el<HTMLInputElement>('code-input');
const sendOtpBtn = el<HTMLButtonElement>('send-otp-btn');
const verifyOtpBtn = el<HTMLButtonElement>('verify-otp-btn');
const loginStatus = el('login-status');
const keyStepEl = el('key-step');
const keyInput = el<HTMLInputElement>('key-input');
const keyBtn = el<HTMLButtonElement>('key-btn');
const lostKeyBtn = el('lost-key-btn');

let pendingPhone: string | null = null;
let pendingCode: string | null = null;

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
    const body = (await res.json()) as SendOtpResponse;
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
    loginStatus.textContent = `Failed to send code: ${errorMessage(err)}`;
  } finally {
    sendOtpBtn.disabled = false;
    phoneInput.disabled = false;
  }
});

// --- Sign in: OTP first, then the API key if the account has one ---------------
async function verify({ apiKey, resetApiKey }: { apiKey?: string; resetApiKey?: boolean } = {}) {
  const res = await fetch(`${functionsBase()}/verifyOtp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone!, code: pendingCode!, apiKey, resetApiKey } satisfies VerifyOtpRequest),
  });
  const body = (await res.json()) as VerifyOtpResponse;

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
  // The code is spent; onAuthStateChanged below takes the user on to the dashboard.
  await signInWithOtpToken(body.token!);
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
    loginStatus.textContent = `Verification failed: ${errorMessage(err)}`;
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
    loginStatus.textContent = `Sign in failed: ${errorMessage(err)}`;
  } finally {
    keyBtn.disabled = false;
  }
});

lostKeyBtn.addEventListener('click', async () => {
  const ok = confirm(
    'Your onboarded phone numbers will be useless.\n\n' +
      'Without your API key we cannot open the access tokens we hold for your numbers, so we have to delete them. ' +
      'Your numbers stay in your list, but each one must be onboarded again before it can send.\n\n' +
      "You'll then get a new API key to note down. Continue?",
  );
  if (!ok) return;
  loginStatus.textContent = 'Resetting…';
  try {
    await verify({ resetApiKey: true });
  } catch (err) {
    loginStatus.textContent = `Reset failed: ${errorMessage(err)}`;
  }
});

// --- Signed in: on to the dashboard ---------------------------------------------------
const toDashboard = () => location.replace('/dashboard/');

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  if (!showNewKeyAfterReset) {
    toDashboard();
    return;
  }
  // After a lost-key reset the new key is shown first, and the user moves on once it is saved.
  showNewKeyAfterReset = false;
  showNewKey({ required: true, note: RESET_KEY_NOTE, save: saveFirstKey, afterSave: toDashboard });
});
