import { auth, onAuthStateChanged } from '/assets/firebase-init.js';
import { fillSidebar, type NumberRecord } from '/assets/waba-sidebar.js';
import '/assets/nav-auth.js';
import { el, errorMessage } from '/assets/dom.js';

// The dashboard: the signed-in user's phone numbers. Anyone else is sent to the sign-in page.
// --- The signed-in dashboard --------------------------------------------------------
function renderCards(numbers: NumberRecord[]) {
  const cards = el('waba-cards');
  cards.replaceChildren();
  el('waba-loading').classList.add('hidden');
  el('waba-cards-empty').classList.toggle('hidden', numbers.length > 0);

  for (const waba of numbers) {
    const card = document.createElement('a');
    card.href = `/dashboard/waba/?id=${encodeURIComponent(waba.id)}`;
    card.className = 'card p-6 hover:shadow-md transition-all flex flex-col gap-1';

    const row = document.createElement('div');
    row.className = 'flex justify-between items-center gap-4';
    const title = document.createElement('p');
    title.className = 'section-title text-on-surface break-all';
    title.textContent = waba.displayPhoneNumber ?? `Phone number ID ${waba.id}`;
    const status = document.createElement('span');
    status.className = 'label-muted whitespace-nowrap';
    // A number with no stored token (after a key reset) can't send until onboarded again.
    status.textContent = !waba.hasToken ? 'Onboard again' : waba.overrideUrl ? 'Incoming URL set' : waba.callbackSkipped ? 'No incoming URL' : 'Setup incomplete';
    status.classList.add(waba.hasToken && (waba.overrideUrl || waba.callbackSkipped) ? 'text-primary' : 'text-on-surface-variant');
    row.append(title, status);
    card.append(row);

    if (waba.wabaId) {
      const w = document.createElement('p');
      w.className = 'text-on-surface-variant font-body-md text-sm';
      w.textContent = `WABA ${waba.wabaId}`;
      card.append(w);
    }
    cards.append(card);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace('/dashboard/login.html');
    return;
  }
  el('signed-in').classList.remove('hidden');
  try {
    renderCards(await fillSidebar(user.uid));
  } catch (err) {
    el('waba-loading').textContent = `Could not load your phone numbers: ${errorMessage(err)}. Reload to try again.`;
  }
});
