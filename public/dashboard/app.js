import { auth, db, functionsBase, onAuthStateChanged, signInWithOtpToken, signOutUser } from '/assets/firebase-init.js';
import {
  collection,
  query,
  where,
  getDocs,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const phoneStepEl = document.getElementById('phone-step');
const codeStepEl = document.getElementById('code-step');
const phoneInput = document.getElementById('phone-input');
const codeInput = document.getElementById('code-input');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const loginStatus = document.getElementById('login-status');
const logoutBtn = document.getElementById('logout-btn');
const wabaListEl = document.getElementById('waba-list');
const wabaListEmptyEl = document.getElementById('waba-list-empty');
const deleteAccountBtn = document.getElementById('delete-account-btn');

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

logoutBtn.addEventListener('click', () => signOutUser());

deleteAccountBtn.addEventListener('click', async () => {
  const user = auth.currentUser;
  if (!user) return;
  if (!confirm('Delete all your onboarded WABAs from our records? This cannot be undone.')) return;

  const snapshot = await getDocs(query(collection(db, 'wabas'), where('ownerUid', '==', user.uid)));
  const batch = writeBatch(db);
  snapshot.forEach((docSnap) => batch.delete(docSnap.ref));
  await batch.commit();

  await loadWabas(user.uid);
  alert('Your WABAs have been deleted.');
});

async function loadWabas(uid) {
  const snapshot = await getDocs(query(collection(db, 'wabas'), where('ownerUid', '==', uid)));
  wabaListEl.innerHTML = '';

  if (snapshot.empty) {
    wabaListEmptyEl.classList.remove('hidden');
    return;
  }
  wabaListEmptyEl.classList.add('hidden');

  snapshot.forEach((docSnap) => {
    const waba = docSnap.data();
    const activated = Boolean(waba.activatedAt);
    const card = document.createElement('a');
    card.href = `/dashboard/waba.html?id=${encodeURIComponent(docSnap.id)}`;
    card.className = 'card p-6 hover:shadow-md transition-all';
    card.innerHTML = `
      <div class="flex justify-between items-center">
        <p class="section-title text-on-surface">${docSnap.id}</p>
        <span class="label-muted ${activated ? 'text-primary' : 'text-on-surface-variant'}">${activated ? 'Active' : 'Setup incomplete'}</span>
      </div>
      <p class="text-on-surface-variant font-body-md text-sm mt-1">WABA ${waba.wabaId ?? '—'}</p>
    `;
    wabaListEl.appendChild(card);
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    signedOutEl.classList.add('hidden');
    signedInEl.classList.remove('hidden');
    loadWabas(user.uid);
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
