// Fills the shared sidebar (views/partials/waba-sidebar.html) with the signed-in
// user's onboarded WABAs, wires up its Delete account button, and returns the
// WABA records. Callers only invoke this when someone is signed in.
import { auth, db, signOutUser } from './firebase-init.js';
import { deleteAccount } from './account.js';
import { el, errorMessage } from './dom.js';
import type { PhoneNumberDoc } from '../../functions/src/helpers/types';
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const ACTIVE = ['bg-primary-container', 'text-on-primary-container', 'font-bold'];
const LINK =
  'flex items-center gap-3 px-2 lg:px-3 py-2.5 rounded-lg font-label-md text-sm hover:bg-surface-container transition-colors justify-center lg:justify-start';

function markActive(target: Element) {
  target.classList.add(...ACTIVE);
  target.classList.remove('text-on-surface-variant');
}

/** A phone number record plus its document id (the phone number ID). */
export type NumberRecord = PhoneNumberDoc & { id: string };

let deleteWired = false;
function wireDelete() {
  if (deleteWired) return;
  deleteWired = true;
  el('delete-account-btn').addEventListener('click', async () => {
    if (!auth.currentUser) return;
    if (!confirm('Delete your account? This removes your numbers and the access tokens we hold for them from our records. It cannot be undone.')) return;
    try {
      await deleteAccount(auth.currentUser.uid);
    } catch (err) {
      alert(`Could not delete your account: ${errorMessage(err)}`);
      return;
    }
    await signOutUser().catch(() => undefined);
    alert('Your account has been deleted.');
    location.href = '/dashboard/';
  });
}

export async function fillSidebar(uid: string, currentId?: string | null): Promise<NumberRecord[]> {
  const sidebar = el('waba-sidebar');
  const list = el('waba-sidebar-list');
  const empty = el('waba-sidebar-empty');

  // Highlight Onboard WABA while on its page.
  if (location.pathname === '/dashboard/waba/create.html') {
    markActive(sidebar.querySelector('[data-nav="onboard"]')!);
  }

  const snapshot = await getDocs(query(collection(db, 'phoneNumbers'), where('userId', '==', uid)));
  const numbers: NumberRecord[] = [];
  list.replaceChildren();
  snapshot.forEach((docSnap) => {
    const waba = docSnap.data() as PhoneNumberDoc;
    numbers.push({ id: docSnap.id, ...waba });
    const link = document.createElement('a');
    link.href = `/dashboard/waba/?id=${encodeURIComponent(docSnap.id)}`;
    link.className = `${LINK} text-on-surface-variant`;
    link.title = `Phone number ID ${docSnap.id}`;

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[22px] flex-shrink-0';
    icon.textContent = waba.overrideUrl && waba.encAccessToken ? 'chat' : 'chat_bubble_outline';

    const label = document.createElement('span');
    label.className = 'hidden lg:inline truncate';
    label.textContent = `Number ${docSnap.id}`;

    link.append(icon, label);
    if (docSnap.id === currentId) markActive(link);
    list.append(link);
  });
  empty.classList.toggle('hidden', !snapshot.empty);
  empty.classList.toggle('lg:block', snapshot.empty);

  sidebar.classList.remove('hidden');
  sidebar.classList.add('flex');
  wireDelete();
  return numbers;
}
