// Fills the shared sidebar (views/partials/waba-sidebar.html) with the signed-in
// user's onboarded WABAs, wires up its Delete account button, and returns the
// WABA records. Callers only invoke this when someone is signed in.
import { auth, db, functionsBase, signOutUser } from '/assets/firebase-init.js';
import { deleteAccount, fetchNumbers, keyMatchesAccount } from '/assets/account.js';
import { isValidApiKey } from '/assets/api-key.js';
import { el, errorMessage } from '/assets/dom.js';
import type { DisconnectNumberRequest, DisconnectNumberResponse, NumberView, UserDoc } from '../../functions/src/helpers/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Selected item: white text on the dark green. Anything the link carried that sets a text
// colour or a hover background has to go, or it competes with these.
const ACTIVE = ['bg-primary', 'text-on-primary', 'font-bold'];
const ACTIVE_REPLACES = ['bg-primary-container', 'text-primary', 'text-on-surface-variant', 'hover:bg-surface-container'];
const LINK =
  'flex items-center gap-3 px-2 lg:px-3 py-2.5 rounded-lg font-label-md text-sm hover:bg-surface-container transition-colors justify-center lg:justify-start';

function markActive(target: Element) {
  target.classList.remove(...ACTIVE_REPLACES);
  target.classList.add(...ACTIVE);
}

/** A phone number record plus its document id (the phone number ID). */
export type NumberRecord = NumberView & { id: string };

// Deleting the account first disconnects each number from Meta (on the server, which needs the
// API key to open the stored token), then deletes our records and the sign-in.
let deleteWired = false;
let currentNumbers: NumberRecord[] = [];

function wireDelete() {
  if (deleteWired) return;
  deleteWired = true;
  const dialog = el('delete-dialog');
  const status = el('delete-status');
  const keyInput = el<HTMLInputElement>('delete-key');
  const lost = el<HTMLInputElement>('delete-lost');
  const confirmBtn = el<HTMLButtonElement>('delete-confirm');
  const anywayBtn = el<HTMLButtonElement>('delete-anyway');

  const withToken = () => currentNumbers.filter((n) => n.hasToken);
  const shown = (n: NumberRecord) => n.displayPhoneNumber ?? `number ${n.id}`;

  function open() {
    const numbers = withToken();
    el('delete-summary').textContent = numbers.length
      ? `Numbers to disconnect: ${numbers.map((n) => `${shown(n)} (${n.isOnBizApp ? 'also on the WhatsApp Business app' : 'API only'})`).join(', ')}.`
      : 'You have no numbers connected to Meta, so there is nothing to disconnect.';
    el('delete-form').classList.toggle('hidden', numbers.length === 0);
    el('delete-deregister-row').classList.toggle('hidden', !numbers.some((n) => !n.isOnBizApp));
    status.textContent = '';
    anywayBtn.classList.add('hidden');
    confirmBtn.disabled = false;
    keyInput.value = '';
    lost.checked = false;
    dialog.classList.remove('hidden');
  }

  /** Disconnects every number from Meta. Returns what the user still has to do themselves, or null if something failed. */
  async function disconnectAll(): Promise<{ coexistence: string[]; deregistered: string[] } | null> {
    const apiKey = keyInput.value.trim();
    if (!isValidApiKey(apiKey) || !(await keyMatchesAccount(auth.currentUser!.uid, apiKey))) {
      status.textContent = 'That is not the API key for this account.';
      return null;
    }
    const done = { coexistence: [] as string[], deregistered: [] as string[] };
    for (const n of withToken()) {
      status.textContent = `Disconnecting ${shown(n)} from Meta…`;
      const res = await fetch(`${functionsBase()}/disconnectNumber`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumberId: n.id, apiKey, deregister: el<HTMLInputElement>('delete-deregister').checked } satisfies DisconnectNumberRequest),
      });
      const body = (await res.json().catch(() => ({}))) as DisconnectNumberResponse;
      if (!res.ok || !body.ok) {
        status.textContent = `Could not disconnect ${shown(n)}: ${body.error || `HTTP ${res.status}`}`;
        return null;
      }
      if (body.coexistence) done.coexistence.push(shown(n));
      if (body.deregistered) done.deregistered.push(shown(n));
    }
    return done;
  }

  async function finish(done: { coexistence: string[]; deregistered: string[] } | null) {
    status.textContent = 'Deleting your account…';
    try {
      await deleteAccount(auth.currentUser!.uid);
    } catch (err) {
      status.textContent = `Could not delete your account: ${errorMessage(err)}`;
      return;
    }
    await signOutUser().catch(() => undefined);

    // What is left for the user to do, which only they can.
    el('delete-form').classList.add('hidden');
    anywayBtn.classList.add('hidden');
    confirmBtn.classList.add('hidden');
    el('delete-title').textContent = 'Your account has been deleted';
    const notes: string[] = [];
    if (done?.deregistered.length) notes.push(`De-registered: ${done.deregistered.join(', ')}. Another provider can onboard them now.`);
    if (done?.coexistence.length) {
      notes.push(`${done.coexistence.join(', ')} ${done.coexistence.length === 1 ? 'is' : 'are'} also on the WhatsApp Business app. To finish disconnecting, open the app: Settings > Account > Business Platform > Disconnect.`);
    }
    if (!done) notes.push('We did not disconnect your numbers from Meta. If you used them with Watobot, disconnect them in the WhatsApp Business app, or ask us.');
    notes.push('If you shared your Messaging accounts with Watobot, you can remove us under Business Settings > Accounts > Partners.');
    status.textContent = notes.join(' ');
    el('delete-cancel').textContent = 'Close';
    el('delete-cancel').onclick = () => (location.href = '/dashboard/');
  }

  el('delete-account-btn').addEventListener('click', () => {
    if (auth.currentUser) open();
  });
  el('delete-cancel').addEventListener('click', () => dialog.classList.add('hidden'));

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const numbers = withToken();
    if (!numbers.length || lost.checked) {
      await finish(null);
      return;
    }
    const done = await disconnectAll();
    if (done) {
      await finish(done);
    } else {
      // A failure leaves the choice to the user: fix it and try again, or delete regardless.
      confirmBtn.disabled = false;
      anywayBtn.classList.remove('hidden');
    }
  });
  anywayBtn.addEventListener('click', () => finish(null));
}

export async function fillSidebar(uid: string, currentId?: string | null): Promise<NumberRecord[]> {
  const sidebar = el('waba-sidebar');
  const list = el('waba-sidebar-list');
  const empty = el('waba-sidebar-empty');

  // Highlight Onboard WABA while on its page.
  if (location.pathname === '/dashboard/waba/create.html') {
    markActive(sidebar.querySelector('[data-nav="onboard"]')!);
  }
  if (location.pathname.startsWith('/dashboard/key')) {
    markActive(sidebar.querySelector('[data-nav="key"]')!);
  }

  // The key page is where an account creates its key, and later changes it.
  const hasKey = Boolean(((await getDoc(doc(db, 'users', uid))).data() as UserDoc | undefined)?.apiKeyHash);
  const keyLabel = hasKey ? 'Modify API key' : 'Create API key';
  el('key-nav-label').textContent = keyLabel;
  sidebar.querySelector('[data-nav="key"]')!.setAttribute('title', keyLabel);

  const numbers: NumberRecord[] = (await fetchNumbers()).map((n) => ({ id: n.phoneNumberId, ...n }));
  list.replaceChildren();
  for (const waba of numbers) {
    const id = waba.id;
    // A number whose onboarding is not finished goes back into the wizard, where it left off.
    const unfinished = waba.step !== 'done';
    const link = document.createElement('a');
    link.href = unfinished
      ? `/dashboard/waba/create.html?id=${encodeURIComponent(id)}`
      : `/dashboard/waba/?id=${encodeURIComponent(id)}`;
    link.className = `${LINK} text-on-surface-variant`;
    const shown = waba.displayPhoneNumber ?? `Number ${id}`;
    link.title = unfinished
      ? `${shown}: onboarding not finished. Continue where you left off.`
      : `${shown} (phone number ID ${id})`;

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[22px] flex-shrink-0';
    if (unfinished) icon.style.color = '#b45309'; // amber: needs attention
    icon.textContent = unfinished ? 'pending' : (waba.overrideUrl || waba.callbackSkipped) && waba.hasToken ? 'chat' : 'chat_bubble_outline';

    const label = document.createElement('span');
    label.className = 'hidden lg:inline truncate';
    label.textContent = unfinished ? `${shown} · finish setup` : shown;

    link.append(icon, label);
    if (id === currentId) markActive(link);
    list.append(link);
  }
  empty.classList.toggle('hidden', numbers.length > 0);
  empty.classList.toggle('lg:block', numbers.length === 0);

  currentNumbers = numbers;
  sidebar.classList.remove('hidden');
  sidebar.classList.add('flex');
  wireDelete();
  return numbers;
}
