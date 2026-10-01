import { functionsBase } from '/assets/firebase-init.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const $ = (id) => document.getElementById(id);

function getToken(resultEl) {
  const token = $('token').value.trim();
  if (!token) resultEl.textContent = 'Paste your access token first.';
  return token;
}

async function request(resultEl, button, makeRequest) {
  const token = getToken(resultEl);
  if (!token) return null;
  button.disabled = true;
  resultEl.textContent = 'Working…';
  try {
    const res = await makeRequest(token);
    const body = await res.json().catch(() => ({}));
    resultEl.textContent = `HTTP ${res.status}\n${JSON.stringify(body, null, 2)}`;
    return { ok: res.ok, body };
  } catch (err) {
    resultEl.textContent = `Request failed: ${err.message}`;
    return null;
  } finally {
    button.disabled = false;
  }
}

// --- Send a message --------------------------------------------------------
$('send-type').addEventListener('change', () => {
  $('send-text-row').classList.toggle('hidden', $('send-type').value !== 'text');
});

$('send-btn').addEventListener('click', () => {
  const phoneNumberId = $('send-phone-number-id').value.trim();
  const message = {
    messaging_product: 'whatsapp',
    to: $('send-to').value.trim(),
    ...($('send-type').value === 'text'
      ? { type: 'text', text: { body: $('send-text').value } }
      : { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }),
  };
  request($('send-result'), $('send-btn'), (token) =>
    fetch(`${functionsBase()}/relayMessage/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }),
  );
});

// --- Message templates -----------------------------------------------------
const list = $('tpl-list');
const empty = $('tpl-empty');

function templatesUrl(query = '') {
  return `${GRAPH}/${encodeURIComponent($('tpl-waba-id').value.trim())}/message_templates${query}`;
}

function line(text, className) {
  const el = document.createElement('p');
  el.className = className;
  el.textContent = text;
  return el;
}

function addCard({ id, name, status, category, language, bodyText }) {
  const card = document.createElement('div');
  card.className = 'card p-4 flex flex-col gap-1';
  card.dataset.name = name;
  card.append(
    line(name, 'font-bold text-on-surface break-all'),
    line(`${status ?? 'PENDING'} · ${category ?? ''} · ${language ?? ''}`, 'label-muted'),
  );
  if (bodyText) card.append(line(bodyText, 'text-on-surface-variant font-body-md text-sm'));

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.className =
    'self-start mt-2 rounded-lg border border-error text-error px-3 py-1 text-sm font-bold hover:bg-error/10 disabled:opacity-50';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete template "${name}" from this WABA?`)) return;
    const result = await request($('tpl-result'), del, (token) =>
      fetch(templatesUrl(`?name=${encodeURIComponent(name)}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (result?.ok) {
      card.remove();
      empty.classList.toggle('hidden', list.children.length > 0);
    }
  });
  card.append(del);
  list.append(card);
  empty.classList.add('hidden');
}

$('tpl-fetch-btn').addEventListener('click', async () => {
  const result = await request($('tpl-result'), $('tpl-fetch-btn'), (token) =>
    fetch(templatesUrl('?fields=id,name,status,category,language,components&limit=100'), {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  if (!result?.ok) return;
  list.replaceChildren();
  for (const t of result.body.data ?? []) {
    const body = (t.components ?? []).find((c) => c.type === 'BODY');
    addCard({ ...t, bodyText: body?.text });
  }
  empty.textContent = 'This WABA has no templates yet.';
  empty.classList.toggle('hidden', list.children.length > 0);
});

$('tpl-create-btn').addEventListener('click', async () => {
  const name = $('tpl-name').value.trim();
  const category = $('tpl-category').value;
  const language = $('tpl-language').value.trim();
  const bodyText = $('tpl-body').value;
  const result = await request($('tpl-result'), $('tpl-create-btn'), (token) =>
    fetch(templatesUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, language, components: [{ type: 'BODY', text: bodyText }] }),
    }),
  );
  if (result?.ok) {
    addCard({
      id: result.body.id,
      name,
      status: result.body.status,
      category: result.body.category ?? category,
      language,
      bodyText,
    });
  }
});
