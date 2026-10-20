// The "Test your endpoint" panel (views/partials/test-events.html): one button posts a test
// webhook of each kind to the user's callback URL, and the user enters the code each carried to
// show their endpoint parsed and saved it. The codes are made and checked on the server.
import { functionsBase } from '/assets/firebase-init.js';
import { callAsUser } from '/assets/account.js';
import { el, errorMessage } from '/assets/dom.js';
import type {
  SendTestEventsRequest,
  SendTestEventsResponse,
  TestEventType,
  VerifyTestCodesRequest,
  VerifyTestCodesResponse,
} from '../../functions/src/helpers/types';

const TYPES: TestEventType[] = ['message', 'echo', 'contacts', 'history'];

/**
 * Wires the panel on the page. `getUrl` says which callback URL to send to; `onChecked` is told
 * whether every code matched the latest send.
 */
export function wireTestEvents(getUrl: () => string, onChecked?: (allCorrect: boolean) => void) {
  const sendBtn = el<HTMLButtonElement>('test-send');
  const checkBtn = el<HTMLButtonElement>('test-check');
  const sendStatus = el('test-send-status');
  const checkStatus = el('test-check-status');
  let sent = false;

  const input = (type: TestEventType) => el<HTMLInputElement>(`test-code-${type}`);
  const mark = (type: TestEventType, state: 'ok' | 'bad' | 'none') => {
    input(type).classList.toggle('border-primary', state === 'ok');
    input(type).classList.toggle('border-error', state === 'bad');
  };

  sendBtn.addEventListener('click', async () => {
    const url = getUrl().trim();
    if (!url) {
      sendStatus.textContent = 'Enter your callback URL first.';
      return;
    }
    sendBtn.disabled = true;
    sendStatus.textContent = 'Sending…';
    checkStatus.textContent = '';
    onChecked?.(false);
    for (const type of TYPES) {
      el(`test-result-${type}`).textContent = '';
      input(type).value = '';
      mark(type, 'none');
    }
    try {
      const res = await callAsUser<SendTestEventsResponse>(`${functionsBase()}/onboarding/test-events`, { overrideCallbackUrl: url } satisfies SendTestEventsRequest);
      sent = true;
      sendStatus.textContent = 'Sent. New codes, enter them below.';
      for (const type of TYPES) {
        const r = res.results![type];
        el(`test-result-${type}`).textContent = r.ok ? `✓ ${r.status} · ${r.ms} ms` : `✗ ${r.error}`;
      }
    } catch (err) {
      sendStatus.textContent = errorMessage(err);
    } finally {
      sendBtn.disabled = false;
    }
  });

  checkBtn.addEventListener('click', async () => {
    if (!sent) {
      checkStatus.textContent = 'Send the test data first.';
      return;
    }
    const codes: VerifyTestCodesRequest['codes'] = {};
    for (const type of TYPES) codes[type] = input(type).value;
    checkBtn.disabled = true;
    try {
      const res = await callAsUser<VerifyTestCodesResponse>(`${functionsBase()}/onboarding/test-codes`, { codes } satisfies VerifyTestCodesRequest);
      const wrong = TYPES.filter((type) => !res.correct![type]);
      for (const type of TYPES) mark(type, res.correct![type] ? 'ok' : 'bad');
      checkStatus.textContent = wrong.length ? `Not matching: ${wrong.join(', ')}.` : 'All four match.';
      onChecked?.(wrong.length === 0);
    } catch (err) {
      checkStatus.textContent = errorMessage(err);
    } finally {
      checkBtn.disabled = false;
    }
  });
}
