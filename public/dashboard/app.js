import { auth, functionsBase, onAuthStateChanged, signInWithOtpToken } from '/assets/firebase-init.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';

const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const phoneStepEl = document.getElementById('phone-step');
const codeStepEl = document.getElementById('code-step');
const phoneInput = document.getElementById('phone-input');
const codeInput = document.getElementById('code-input');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const loginStatus = document.getElementById('login-status');

let pendingPhone = null;

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

verifyOtpBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!code) {
    loginStatus.textContent = 'Enter the code you received.';
    return;
  }
  verifyOtpBtn.disabled = true;
  loginStatus.textContent = 'Verifying…';
  try {
    const res = await fetch(`${functionsBase()}/verifyOtp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, code }),
    });
    const body = await res.json();
    if (!body.ok) {
      loginStatus.textContent = body.error || 'Verification failed.';
      return;
    }
    await signInWithOtpToken(body.token);
  } catch (err) {
    loginStatus.textContent = `Verification failed: ${err.message}`;
  } finally {
    verifyOtpBtn.disabled = false;
  }
});


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
    title.textContent = `WABA ${waba.id}`;
    const status = document.createElement('span');
    status.className = `label-muted whitespace-nowrap ${waba.overrideUrl ? 'text-primary' : 'text-on-surface-variant'}`;
    status.textContent = waba.overrideUrl ? 'Incoming URL set' : 'Setup incomplete';
    row.append(title, status);
    card.append(row);

    if (waba.phoneNumberId) {
      const phone = document.createElement('p');
      phone.className = 'text-on-surface-variant font-body-md text-sm';
      phone.textContent = `Phone number ID ${waba.phoneNumberId}`;
      card.append(phone);
    }
    cards.append(card);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    signedOutEl.classList.add('hidden');
    signedInEl.classList.remove('hidden');
    renderCards(await fillSidebar(user.uid));
  } else {
    signedInEl.classList.add('hidden');
    signedOutEl.classList.remove('hidden');
    pendingPhone = null;
    codeStepEl.classList.add('hidden');
    phoneStepEl.classList.remove('hidden');
    iti.setNumber('');
    codeInput.value = '';
    loginStatus.textContent = '';
  }
});
