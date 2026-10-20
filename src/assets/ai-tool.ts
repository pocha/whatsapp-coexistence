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

  button.addEventListener('click', () => {
    const value = key.value.trim();
    if (!isValidApiKey(value)) return;
    const mcp = `${functionsBase()}/mcp`;
    el('ai-url').textContent = `${mcp}/${value}`;
    el('ai-http-cmd').textContent = `claude mcp add --transport http watobot ${mcp} --header "Authorization: Bearer ${value}"`;
    el('ai-cmd').textContent = `claude mcp add watobot -e WATOBOT_API_KEY=${value} -- npx -y watobot-mcp`;
    for (const copy of Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) copy.textContent = 'Copy';
    dialog.showModal();
  });

  el('ai-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    // The commands hold the key: don't leave them in the page.
    for (const id of ['ai-url', 'ai-http-cmd', 'ai-cmd']) el(id).textContent = '';
  });
  for (const copy of Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-copy]'))) {
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(el(copy.dataset.copy!).textContent ?? '');
      copy.textContent = 'Copied';
    });
  }
}
