// On dashboard pages, the nav bar's "Open Dashboard" button becomes a Logout
// button while someone is signed in. Imported only by those pages, so the
// marketing pages keep "Open Dashboard".
import { auth, onAuthStateChanged, signOutUser } from './firebase-init.js';

const cta = document.getElementById('nav-cta');
const original = cta ? { html: cta.innerHTML, className: cta.className, href: cta.getAttribute('href') ?? '' } : null;

async function logout(event: Event) {
  event.preventDefault();
  await signOutUser();
  location.href = '/dashboard/';
}

onAuthStateChanged(auth, (user) => {
  if (!cta || !original) return;
  if (user) {
    cta.className =
      'flex items-center gap-2 text-error hover:bg-error/10 px-4 py-2 rounded-xl transition-all font-label-md text-label-md font-bold';
    cta.innerHTML = '<span class="material-symbols-outlined text-[20px]">logout</span><span>Logout</span>';
    cta.removeAttribute('href');
    cta.style.cursor = 'pointer';
    cta.addEventListener('click', logout);
  } else {
    cta.removeEventListener('click', logout);
    cta.className = original.className;
    cta.innerHTML = original.html;
    cta.setAttribute('href', original.href);
    cta.style.cursor = '';
  }
});
