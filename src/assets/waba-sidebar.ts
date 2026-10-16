// Fills the shared sidebar (views/partials/waba-sidebar.html) with the signed-in
// user's onboarded WABAs, wires up its Delete account button, and returns the
// WABA records. Callers only invoke this when someone is signed in.
import { auth, db, signOutUser } from '/assets/firebase-init.js';
import { deleteAccount } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import type { PhoneNumberDoc, UserDoc } from '../../functions/src/helpers/types';
import { effectiveStep } from '../../functions/src/helpers/onboardingSteps';
import {
  collection,
  doc,
  getDoc,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

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
  if (location.pathname.startsWith('/dashboard/key')) {
    markActive(sidebar.querySelector('[data-nav="key"]')!);
  }

  // The key page is where an account creates its key, and later changes it.
  const hasKey = Boolean(((await getDoc(doc(db, 'users', uid))).data() as UserDoc | undefined)?.apiKeyHash);
  const keyLabel = hasKey ? 'Modify API key' : 'Create API key';
  el('key-nav-label').textContent = keyLabel;
  sidebar.querySelector('[data-nav="key"]')!.setAttribute('title', keyLabel);

  const snapshot = await getDocs(query(collection(db, 'phoneNumbers'), where('userId', '==', uid)));
  const numbers: NumberRecord[] = [];
  list.replaceChildren();
  snapshot.forEach((docSnap) => {
    const waba = docSnap.data() as PhoneNumberDoc;
    numbers.push({ id: docSnap.id, ...waba });
    // A number whose onboarding is not finished goes back into the wizard, where it left off.
    const unfinished = effectiveStep(waba) !== 'done';
    const link = document.createElement('a');
    link.href = unfinished
      ? `/dashboard/waba/create.html?id=${encodeURIComponent(docSnap.id)}`
      : `/dashboard/waba/?id=${encodeURIComponent(docSnap.id)}`;
    link.className = `${LINK} text-on-surface-variant`;
    const shown = waba.displayPhoneNumber ?? `Number ${docSnap.id}`;
    link.title = unfinished
      ? `${shown}: onboarding not finished. Continue where you left off.`
      : `${shown} (phone number ID ${docSnap.id})`;

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[22px] flex-shrink-0';
    if (unfinished) icon.style.color = '#b45309'; // amber: needs attention
    icon.textContent = unfinished ? 'pending' : waba.overrideUrl && waba.encAccessToken ? 'chat' : 'chat_bubble_outline';

    const label = document.createElement('span');
    label.className = 'hidden lg:inline truncate';
    label.textContent = unfinished ? `${shown} · finish setup` : shown;

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
