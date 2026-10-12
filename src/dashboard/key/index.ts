import { auth, db, onAuthStateChanged } from '/assets/firebase-init.js';
import { fillSidebar } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { isValidApiKey } from '/assets/api-key.js';
import { keyMatchesAccount, resetKey, rotateKey } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import { FIRST_KEY_NOTE, NEW_KEY_NOTE, saveFirstKey, showNewKey, signOutAfterNewKey } from '/assets/key-dialog.js';
import type { UserDoc } from '../../../functions/src/helpers/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// The one place for the Watobot API key. No key yet: create one. Otherwise: replace it (needs
// the current one), or reset it after losing it. Signed-in only: anyone else is sent to the
// Dashboard's sign-in.
const rotateBtn = el<HTMLButtonElement>('rotate-btn');
const rotateStatus = el('rotate-status');

rotateBtn.addEventListener('click', async () => {
  const oldApiKey = el<HTMLInputElement>('rotate-old').value.trim();
  if (!isValidApiKey(oldApiKey)) {
    rotateStatus.textContent = 'Enter your current API key first.';
    return;
  }
  if (!(await keyMatchesAccount(auth.currentUser!.uid, oldApiKey))) {
    rotateStatus.textContent = 'That is not the current key for this account.';
    return;
  }
  rotateStatus.textContent = '';
  showNewKey({
    required: false,
    note: NEW_KEY_NOTE,
    save: (newApiKey) => rotateKey(oldApiKey, newApiKey),
    afterSave: signOutAfterNewKey,
  });
});

el('reset-key-btn').addEventListener('click', async () => {
  const ok = confirm(
    'Your onboarded WABAs will be useless.\n\n' +
      'Only do this if you lost your key. We will delete the access tokens we hold for your numbers, and each number must be onboarded again before it can send. Continue?',
  );
  if (!ok) return;
  try {
    await resetKey(auth.currentUser!.uid);
    showNewKey({ required: true, note: NEW_KEY_NOTE, save: saveFirstKey, afterSave: signOutAfterNewKey });
  } catch (err) {
    rotateStatus.textContent = `Reset failed: ${errorMessage(err)}`;
  }
});

el('create-key-btn').addEventListener('click', () =>
  showNewKey({ required: true, note: FIRST_KEY_NOTE, save: saveFirstKey, afterSave: signOutAfterNewKey }),
);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = '/dashboard/';
    return;
  }
  fillSidebar(user.uid);

  const hasKey = Boolean(((await getDoc(doc(db, 'users', user.uid))).data() as UserDoc | undefined)?.apiKeyHash);
  el('key-title').textContent = hasKey ? 'Modify API key' : 'Create API key';
  el(hasKey ? 'modify-key-card' : 'create-key-card').classList.remove('hidden');
});
