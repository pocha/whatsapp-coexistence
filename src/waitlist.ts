import { db, functionsBase } from '/assets/firebase-init.js';
import { el } from '/assets/dom.js';
import type { JoinWaitlistResponse } from '../functions/src/helpers/types';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Scroll reveal: sections fade in as they enter the view, then drop their reveal classes so
// hover effects work. Without JS, or with reduced motion, everything is simply visible.
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('reveal-ready');
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        seen.unobserve(node);
        node.classList.add('in');
        setTimeout(() => node.classList.remove('reveal', 'in'), 900);
      }
    },
    { threshold: 0.15 },
  );
  document.querySelectorAll('.reveal').forEach((node) => seen.observe(node));
}

// The hero carousel: one slide at a time, moving on every few seconds unless the visitor points at it
// or has asked for less motion. The dots jump to a slide.
const carousel = document.getElementById('hero-carousel');
if (carousel) {
  const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-slide]'));
  const dots = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[data-dot]'));
  const title = el('hero-slide-title');
  let current = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const show = (index: number) => {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle('hidden', i !== current));
    dots.forEach((dot, i) => {
      dot.classList.toggle('bg-primary', i === current);
      dot.classList.toggle('bg-outline-variant', i !== current);
      dot.setAttribute('aria-current', String(i === current));
    });
    title.textContent = slides[current].dataset.title ?? '';
  };
  const play = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stop();
    timer = setInterval(() => show(current + 1), 7000);
  };
  const stop = () => clearInterval(timer);

  dots.forEach((dot, i) => dot.addEventListener('click', () => (show(i), play())));
  carousel.addEventListener('mouseenter', stop);
  carousel.addEventListener('mouseleave', play);
  carousel.addEventListener('focusin', stop);
  carousel.addEventListener('focusout', play);
  show(0);
  play();
}

const btn = el<HTMLButtonElement>('join-btn');
const countEl = el('join-count');
const dialog = el<HTMLDialogElement>('join-dialog');
const COUNTED_KEY = 'watobot_waitlist_counted';

// The dashboard sends visitors here with ?join-waitlist=true while the app
// waits for Meta's approval.
if (new URLSearchParams(location.search).get('join-waitlist') === 'true') {
  el('waitlist-alert').classList.remove('hidden');
  el('waitlist-alert-close').addEventListener('click', () => {
    el('waitlist-alert').classList.add('hidden');
  });
}

function showCount(count: unknown) {
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
el('join-close').addEventListener('click', () => dialog.close());
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
    const body = (await res.json()) as JoinWaitlistResponse;
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
