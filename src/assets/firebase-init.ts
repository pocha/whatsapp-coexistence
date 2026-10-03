// Shared Firebase client setup — imported by every dashboard page.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Public, non-secret config — safe to embed in frontend code. Authorization
// comes from Firestore/Functions security rules and Firebase ID tokens, not
// from keeping this value hidden.
const firebaseConfig = {
  projectId: 'wa-coexistence',
  appId: '1:743817787553:web:6a045f58cc3c2d494dd8e0',
  storageBucket: 'wa-coexistence.firebasestorage.app',
  apiKey: 'AIzaSyAJIP4QSB6NHjpyUlP50T2il0udSdt_04Q',
  authDomain: 'wa-coexistence.firebaseapp.com',
  messagingSenderId: '743817787553',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if (isLocal) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  // Emulated Auth too: verifyOtp's createCustomToken needs real credentials
  // to sign against real Firebase, but the Auth emulator issues unsigned
  // tokens, so local dev needs no service account key.
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

// Same split-origin pattern as watobot: same-origin API calls don't apply
// here since Functions are always cross-origin from GitHub Pages, but this
// still needs to point at the emulator during local dev.
export function functionsBase() {
  return isLocal
    ? 'http://127.0.0.1:5001/wa-coexistence/us-central1'
    : 'https://us-central1-wa-coexistence.cloudfunctions.net';
}

// Login is phone number + WhatsApp OTP (sendOtp/verifyOtp Functions), not a
// Meta login product at all — no scopes, no Configuration to fight with.
// verifyOtp mints a Firebase custom token keyed by the phone number itself;
// this just finishes that sign-in client-side.
export function signInWithOtpToken(token: string) {
  return signInWithCustomToken(auth, token);
}

export function signOutUser() {
  return signOut(auth);
}

export { onAuthStateChanged };
