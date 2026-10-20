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

// The hero carousel: each slide plays out like a Claude Code session, the prompt typed, the tool
// calls appearing one after another, the reply streaming in. Then it moves to the next slide, unless
// the visitor is pointing at it. The dots jump to a slide. With reduced motion, or without this
// script, the whole text of the slide is simply shown.
const carousel = document.getElementById('hero-carousel');
if (carousel) {
  const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-slide]'));
  const dots = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[data-dot]'));
  const title = el('hero-slide-title');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let current = 0;
  let run = 0; // a new run cancels the one before it
  let hovered = false;

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

  /** Types `node`'s text out, a few characters at a time (`step` of them, `ms` apart). */
  async function type(node: HTMLElement, mine: number, ms: number, step: number, caret?: HTMLElement | null) {
    const full = node.dataset.full ?? node.textContent ?? '';
    node.dataset.full = full;
    node.textContent = '';
    caret?.classList.remove('hidden');
    for (let i = step; i < full.length + step; i += step) {
      if (run !== mine) return;
      node.textContent = full.slice(0, i);
      await sleep(ms + Math.random() * ms * 0.6);
    }
    caret?.classList.add('hidden');
  }

  async function play(index: number) {
    const mine = ++run;
    show(index);
    const lines = Array.from(slides[current].querySelectorAll<HTMLElement>('[data-line]'));
    const results = lines.flatMap((line) => Array.from(line.querySelectorAll<HTMLElement>('[data-result]')));
    const carets = Array.from(slides[current].querySelectorAll<HTMLElement>('.caret'));
    if (still) {
      lines.forEach((line) => line.classList.remove('hidden'));
      results.forEach((result) => result.classList.remove('hidden'));
      return;
    }
    lines.forEach((line) => line.classList.add('hidden'));
    results.forEach((result) => result.classList.add('hidden'));
    carets.forEach((caret) => caret.classList.add('hidden'));

    await sleep(500);
    for (const line of lines) {
      if (run !== mine) return;
      line.classList.remove('hidden');
      const text = line.querySelector<HTMLElement>('[data-text]');
      if (line.dataset.line === 'type' && text) {
        await type(text, mine, 28, 1, line.querySelector('.caret'));
        await sleep(450);
      } else if (line.dataset.line === 'say' && text) {
        await type(text, mine, 45, 3);
      } else if (line.dataset.line === 'tool') {
        await sleep(700);
        line.querySelectorAll<HTMLElement>('[data-result]').forEach((result) => result.classList.remove('hidden'));
      }
      await sleep(350);
    }
    // Hold the finished slide, then the next one, unless the visitor is looking at it.
    await sleep(3500);
    while (hovered && run === mine) await sleep(300);
    if (run === mine) void play(current + 1);
  }

  dots.forEach((dot, i) => dot.addEventListener('click', () => void play(i)));
  carousel.addEventListener('mouseenter', () => (hovered = true));
  carousel.addEventListener('mouseleave', () => (hovered = false));
  carousel.addEventListener('focusin', () => (hovered = true));
  carousel.addEventListener('focusout', () => (hovered = false));
  void play(0);
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
