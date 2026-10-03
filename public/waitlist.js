import { db, functionsBase } from '/assets/firebase-init.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const btn = document.getElementById('join-btn');
const countEl = document.getElementById('join-count');
const dialog = document.getElementById('join-dialog');
const COUNTED_KEY = 'watobot_waitlist_counted';

// The dashboard sends visitors here with ?join-waitlist=true while the app
// waits for Meta's approval.
if (new URLSearchParams(location.search).get('join-waitlist') === 'true') {
  document.getElementById('waitlist-alert').classList.remove('hidden');
  document.getElementById('waitlist-alert-close').addEventListener('click', () => {
    document.getElementById('waitlist-alert').classList.add('hidden');
  });
}

function showCount(count) {
  if (typeof count !== 'number' || count < 1) return;
  countEl.textContent = `${count.toLocaleString()} ${count === 1 ? 'person' : 'people'} joined`;
  countEl.classList.remove('hidden');
}

// Show the current total on load. Failing to read it is not worth bothering the
// visitor about; the page works without it.
(async () => {
  try {
    showCount((await getDoc(doc(db, 'meta', 'waitlist'))).data()?.count);
  } catch {
    // No count to show.
  }
})();

// Close the popup with its X, with Esc (built in), or by clicking the backdrop.
document.getElementById('join-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

btn.addEventListener('click', async () => {
  // Show the group link right away.
  dialog.showModal();

  // Count each browser once, so clicking again later doesn't inflate it.
  let alreadyCounted = false;
  try {
    alreadyCounted = localStorage.getItem(COUNTED_KEY) === '1';
  } catch {
    // Storage unavailable: fall through and count it.
  }
  if (alreadyCounted) return;

  try {
    const res = await fetch(`${functionsBase()}/joinWaitlist`, { method: 'POST' });
    const body = await res.json();
    if (body.ok) {
      showCount(body.count);
      try {
        localStorage.setItem(COUNTED_KEY, '1');
      } catch {
        // Ignore.
      }
    }
  } catch {
    // The visitor still got the link; the count just misses this click.
  }
});
