document.getElementById('send-btn').addEventListener('click', async () => {
  const body = {
    phoneNumberId: document.getElementById('send-phone-number-id').value.trim(),
    to: document.getElementById('send-to').value.trim(),
    text: document.getElementById('send-text').value,
  };
  const res = await fetch('/api/test/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('send-result').textContent = JSON.stringify(await res.json(), null, 2);
});

document.getElementById('tpl-btn').addEventListener('click', async () => {
  const body = {
    wabaId: document.getElementById('tpl-waba-id').value.trim(),
    phoneNumberId: document.getElementById('tpl-phone-number-id').value.trim(),
    name: document.getElementById('tpl-name').value.trim(),
    category: document.getElementById('tpl-category').value,
    language: document.getElementById('tpl-language').value.trim(),
    bodyText: document.getElementById('tpl-body').value,
  };
  const res = await fetch('/api/test/create-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('tpl-result').textContent = JSON.stringify(await res.json(), null, 2);
});
