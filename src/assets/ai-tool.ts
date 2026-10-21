import { functionsBase } from '/assets/firebase-init.js';
import { isValidApiKey } from '/assets/api-key.js';
import { el } from '/assets/dom.js';

// The "Connect your AI tool" box: the user pastes their API key, and the button opens a window with the setup
// for each kind of tool (views/partials/ai-tool-dialog.html). It is put together here from the key: nothing is sent.
export function wireAiTool(): void {
  const key = el<HTMLInputElement>('ai-key');
  const button = el<HTMLButtonElement>('ai-connect');
  const status = el('ai-status');
  const dialog = el<HTMLDialogElement>('ai-dialog');

  key.addEventListener('input', () => {
    const value = key.value.trim();
    const ok = isValidApiKey(value);
    button.disabled = !ok;
    status.textContent = value && !ok ? 'An API key is 64 characters of 0-9 and a-f.' : '';
  });

  // The tools are tabs: one panel shows at a time.
  const tabs = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
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

  button.addEventListener('click', () => {
    const value = key.value.trim();
    if (!isValidApiKey(value)) return;
    const mcp = `${functionsBase()}/mcp`;
    const url = `${mcp}/${value}`;
    el('ai-url').textContent = url;
    el('ai-url-2').textContent = url;
    el('ai-http-cmd').textContent = `claude mcp add --transport http watobot ${mcp} --header "Authorization: Bearer ${value}"`;
    el('ai-json').textContent = JSON.stringify({ mcpServers: { watobot: { command: 'npx', args: ['-y', 'watobot-mcp'], env: { WATOBOT_API_KEY: value } } } }, null, 2);
    for (const copy of Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) copy.textContent = 'Copy';
    select(tabs[0].dataset.tab!);
    dialog.showModal();
  });

  el('ai-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    // The commands hold the key: don't leave them in the page.
    for (const id of ['ai-url', 'ai-url-2', 'ai-http-cmd', 'ai-json']) el(id).textContent = '';
  });
  for (const copy of Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) {
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(el(copy.dataset.copy!).textContent ?? '');
      copy.textContent = 'Copied';
    });
  }
}
