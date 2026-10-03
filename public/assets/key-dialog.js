// The "here is your new API key" popup, shared by the dashboard and the onboarding
// page (markup: views/partials/key-dialog.html).
import { auth, signOutUser } from './firebase-init.js';
import { generateApiKey } from './api-key.js';
import { setFirstKey } from './account.js';

/**
 * Generates a key in the browser and shows it. `save(key)` runs when the user clicks
 * Next, followed by `afterSave(key)`. `required` stops the popup being dismissed.
 */
export function showNewKey({ note, required, save, afterSave }) {
  const dialog = document.getElementById('key-dialog');
  const done = document.getElementById('key-dialog-done');
  const status = document.getElementById('key-dialog-status');
  const copy = document.getElementById('key-dialog-copy');

  const key = generateApiKey();
  document.getElementById('key-dialog-value').value = key;
  document.getElementById('key-dialog-note').textContent = note ?? '';
  done.disabled = false;
  status.textContent = '';
  copy.textContent = 'Copy';

  dialog.oncancel = (event) => {
    if (required) event.preventDefault();
  };
  copy.onclick = async () => {
    await navigator.clipboard.writeText(key);
    copy.textContent = 'Copied';
  };
  done.onclick = async () => {
    done.disabled = true;
    status.textContent = 'Saving…';
    try {
      await save(key);
      dialog.close();
      await afterSave?.(key);
    } catch (err) {
      status.textContent = `Could not save: ${err.message}`;
      done.disabled = false;
    }
  };
  dialog.showModal();
}

export const FIRST_KEY_NOTE =
  "You'll need this key to onboard your numbers. For security, we're signing you out when you click Next, and you'll need to provide this key when you sign in.";
export const NEW_KEY_NOTE =
  "Your old key stops working. For security, we're signing you out when you click Next, and you'll need to provide this new key when you sign in.";
export const RESET_KEY_NOTE = 'Your old key no longer works. Keep this one safe: you will need it to sign in.';

/** Saves the hash of a brand-new key (the account has none yet). */
export const saveFirstKey = (key) => setFirstKey(auth.currentUser.uid, key);

/** After creating or replacing a key, the user is signed out so they must type it to get back in. */
export const signOutAfterNewKey = () => signOutUser().catch(() => undefined);
