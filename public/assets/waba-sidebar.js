// Fills the shared sidebar (views/partials/waba-sidebar.html) with the signed-in
// user's onboarded numbers. Callers only invoke this when someone is signed in.
import { db } from './firebase-init.js';
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export async function fillSidebar(uid, currentId) {
  const sidebar = document.getElementById('waba-sidebar');
  const list = document.getElementById('waba-sidebar-list');
  const empty = document.getElementById('waba-sidebar-empty');

  const snapshot = await getDocs(query(collection(db, 'wabas'), where('ownerUid', '==', uid)));
  list.replaceChildren();
  snapshot.forEach((docSnap) => {
    const waba = docSnap.data();
    const link = document.createElement('a');
    link.href = `/waba.html?id=${encodeURIComponent(docSnap.id)}`;
    link.className =
      'card p-3 flex flex-col hover:shadow-md transition-all' +
      (docSnap.id === currentId ? ' border-primary' : '');

    const name = document.createElement('span');
    name.className = 'font-bold text-on-surface break-all';
    name.textContent = docSnap.id;

    const status = document.createElement('span');
    status.className = 'label-muted';
    status.textContent = waba.overrideUrl ? 'Incoming URL set' : 'Setup incomplete';

    link.append(name, status);
    list.append(link);
  });
  empty.classList.toggle('hidden', !snapshot.empty);
  sidebar.classList.remove('hidden');
}

export function hideSidebar() {
  document.getElementById('waba-sidebar')?.classList.add('hidden');
}
