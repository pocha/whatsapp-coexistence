import { functionsBase } from '/assets/firebase-init.js';
import { isValidApiKey } from '/assets/api-key.js';
import { el } from '/assets/dom.js';

// The setup for each AI tool (views/partials/ai-tool-tabs.html), put together here from the Watobot API key.
// Nothing is sent anywhere. The onboarding page shows it in a window (wireAiTool); the number page shows it in an
// accordion (wireAiTabs and fillAiTool, with the key typed in its API key card).

const IDS = ['ai-url', 'ai-url-2', 'ai-http-cmd', 'ai-json'];
export const KEY_PLACEHOLDER = 'YOUR_WATOBOT_API_KEY';

/** Writes the address, command and config for each tool, with `key` in them. */
export function fillAiTool(key: string): void {
  const mcp = `${functionsBase()}/mcp`;
  const url = `${mcp}/${key}`;
  el('ai-url').textContent = url;
  el('ai-url-2').textContent = url;
  el('ai-http-cmd').textContent = `claude mcp add --transport http watobot ${mcp} --header "Authorization: Bearer ${key}"`;
  el('ai-json').textContent = JSON.stringify({ mcpServers: { watobot: { command: 'npx', args: ['-y', 'watobot-mcp'], env: { WATOBOT_API_KEY: key } } } }, null, 2);
}

/** Empties them, so a key doesn't stay in the page. */
export function clearAiTool(): void {
  for (const id of IDS) el(id).textContent = '';
}

/** The tools are tabs, one panel at a time, and each Copy button copies its box. Returns a function that shows the first tab. */
export function wireAiTabs(root: HTMLElement): () => void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const select = (name: string) => {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('bg-primary', on);
      tab.classList.toggle('text-on-primary', on);
      tab.classList.toggle('text-on-surface-variant', !on);
      tab.classList.toggle('hover:bg-surface-container', !on);
      el(`ai-panel-${tab.dataset.tab}`).classList.toggle('hidden', !on);
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab.dataset.tab!));
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(i + tabs.length - 1) % tabs.length] : undefined;
      if (!next) return;
      select(next.dataset.tab!);
      next.focus();
    });
  });
  for (const copy of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) {
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(el(copy.dataset.copy!).textContent ?? '');
      copy.textContent = 'Copied';
    });
  }
  return () => {
    for (const copy of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) copy.textContent = 'Copy';
    select(tabs[0].dataset.tab!);
  };
}

/** The "Connect your AI tool" box of the onboarding page: the user pastes their API key, and the button opens a window with the setup. */
export function wireAiTool(): void {
  const key = el<HTMLInputElement>('ai-key');
  const button = el<HTMLButtonElement>('ai-connect');
  const status = el('ai-status');
  const dialog = el<HTMLDialogElement>('ai-dialog');
  const showFirstTab = wireAiTabs(dialog);

  key.addEventListener('input', () => {
    const value = key.value.trim();
    const ok = isValidApiKey(value);
    button.disabled = !ok;
    status.textContent = value && !ok ? 'An API key is 64 characters of 0-9 and a-f.' : '';
  });

  button.addEventListener('click', () => {
    const value = key.value.trim();
    if (!isValidApiKey(value)) return;
    fillAiTool(value);
    showFirstTab();
    dialog.showModal();
  });

  el('ai-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  // The commands hold the key: don't leave them in the page.
  dialog.addEventListener('close', clearAiTool);
}
