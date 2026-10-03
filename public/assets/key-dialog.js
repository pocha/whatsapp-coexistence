// The "here is your new API key, note it down" popup, shared by the dashboard and the
// onboarding page (markup: views/partials/key-dialog.html).
import { auth, functionsBase, signOutUser } from './firebase-init.js';
import { callAsUser, clearStoredKey, generateApiKey, storeKey } from './api-key.js';

/**
 * Generates a key in the browser and shows it. Only once the user pastes it back
 * (proving they copied it) does `save(key)` run, followed by `afterSave(key)`.
 * `required` stops the popup being dismissed.
 */
export function showNewKey({ note, required, save, afterSave }) {
  const dialog = document.getElementById('key-dialog');
  const value = document.getElementById('key-dialog-value');
  const confirm = document.getElementById('key-dialog-confirm');
  const done = document.getElementById('key-dialog-done');
  const status = document.getElementById('key-dialog-status');
  const copy = document.getElementById('key-dialog-copy');

  const key = generateApiKey();
  value.value = key;
  confirm.value = '';
  done.disabled = true;
  status.textContent = '';
  copy.textContent = 'Copy';
  document.getElementById('key-dialog-note').textContent = note ?? '';

  dialog.oncancel = (event) => {
    if (required) event.preventDefault();
  };
  confirm.oninput = () => {
    done.disabled = confirm.value.trim() !== key;
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
  "You'll need this key every time you sign in. When you click Next, we'll sign you out.";
export const NEW_KEY_NOTE =
  'Your old key stops working. When you click Next, we\'ll sign you out, and you\'ll need this new key to sign in.';

/** Saves the hash of a brand-new key (the account has none yet). */
export const saveFirstKey = (key) => callAsUser(auth, `${functionsBase()}/setApiKey`, { apiKey: key });

/** After creating or replacing a key: forget any copy kept in this browser, then sign out. */
export async function signOutToRememberKey() {
  clearStoredKey();
  await signOutUser().catch(() => undefined);
}

/** For a lost-key reset at sign-in: the user stays signed in, with the new key remembered. */
export function keepSignedInWith(key) {
  storeKey(key);
}
