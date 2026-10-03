// Fills the shared sidebar (views/partials/waba-sidebar.html) with the signed-in
// user's onboarded WABAs, wires up its Delete account button, and returns the
// WABA records. Callers only invoke this when someone is signed in.
import { auth, db, signOutUser } from './firebase-init.js';
import { deleteAccount } from './account.js';
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const ACTIVE = ['bg-primary-container', 'text-on-primary-container', 'font-bold'];
const LINK =
  'flex items-center gap-3 px-2 lg:px-3 py-2.5 rounded-lg font-label-md text-sm hover:bg-surface-container transition-colors justify-center lg:justify-start';

function markActive(el) {
  el.classList.add(...ACTIVE);
  el.classList.remove('text-on-surface-variant');
}

let deleteWired = false;
function wireDelete() {
  if (deleteWired) return;
  deleteWired = true;
  document.getElementById('delete-account-btn').addEventListener('click', async () => {
    if (!auth.currentUser) return;
    if (!confirm('Delete your account? This removes your numbers and the access tokens we hold for them from our records. It cannot be undone.')) return;
    try {
      await deleteAccount(auth.currentUser.uid);
    } catch (err) {
      alert(`Could not delete your account: ${err.message}`);
      return;
    }
    await signOutUser().catch(() => undefined);
    alert('Your account has been deleted.');
    location.href = '/dashboard/';
  });
}

export async function fillSidebar(uid, currentId) {
  const sidebar = document.getElementById('waba-sidebar');
  const list = document.getElementById('waba-sidebar-list');
  const empty = document.getElementById('waba-sidebar-empty');

  // Highlight Onboard WABA while on its page.
  if (location.pathname === '/dashboard/waba.html') {
    markActive(sidebar.querySelector('[data-nav="onboard"]'));
  }

  const snapshot = await getDocs(query(collection(db, 'phoneNumbers'), where('userId', '==', uid)));
  const numbers = [];
  list.replaceChildren();
  snapshot.forEach((docSnap) => {
    const waba = docSnap.data();
    numbers.push({ id: docSnap.id, ...waba });
    const link = document.createElement('a');
    link.href = `/waba.html?id=${encodeURIComponent(docSnap.id)}`;
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

export function hideSidebar() {
  const sidebar = document.getElementById('waba-sidebar');
  sidebar?.classList.add('hidden');
  sidebar?.classList.remove('flex');
}
