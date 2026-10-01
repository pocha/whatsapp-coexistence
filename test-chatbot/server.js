// Minimal test chatbot for trying WA Coexistence end to end. No dependencies.
//   GET  /webhook  answers Meta's verification handshake (what the wizard's
//                  "Test endpoint" step calls)
//   POST /webhook  logs every incoming event, and replies "You said: ..." to
//                  text messages through the relay
const http = require('node:http');

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const RELAY_BASE =
  process.env.RELAY_BASE || 'http://127.0.0.1:5001/wa-coexistence/us-central1/relayMessage';

if (!VERIFY_TOKEN) {
  console.error('Set WEBHOOK_VERIFY_TOKEN (the same value as in functions/.env). See .env.example.');
  process.exit(1);
}
if (!ACCESS_TOKEN) {
  console.warn('ACCESS_TOKEN is not set: incoming messages will be logged but not answered.');
}

async function reply(phoneNumberId, to, text) {
  const res = await fetch(`${RELAY_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  console.log(`  reply to ${to}: relay answered ${res.status} ${await res.text()}`);
}

async function handleEvent(body) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Only "messages" events carry customer messages. Others (statuses,
      // smb_message_echoes, ...) are logged by the caller and ignored here.
      if (change.field !== 'messages') continue;
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      for (const message of change.value?.messages ?? []) {
        if (message.type !== 'text' || !ACCESS_TOKEN) continue;
        await reply(phoneNumberId, message.from, `You said: ${message.text.body}`);
      }
    }
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/webhook') {
      res.writeHead(404).end('Not found');
      return;
    }

    if (req.method === 'GET') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
      console.log(`GET /webhook handshake: ${ok ? 'ok' : 'REJECTED (verify token mismatch)'}`);
      if (ok) res.writeHead(200, { 'Content-Type': 'text/plain' }).end(url.searchParams.get('hub.challenge'));
      else res.writeHead(403).end('Forbidden');
      return;
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.writeHead(200).end('ok'); // acknowledge first; Meta retries on slow responses
        try {
          const body = JSON.parse(raw);
          console.log('POST /webhook:', JSON.stringify(body, null, 2));
          handleEvent(body).catch((err) => console.error('  handler error:', err.message));
        } catch {
          console.log('POST /webhook: body was not JSON');
        }
      });
      return;
    }

    res.writeHead(405).end();
  })
  .listen(PORT, () => {
    console.log(`Test chatbot listening on http://localhost:${PORT}/webhook`);
    console.log('Expose it publicly over HTTPS, then use <public-url>/webhook as your endpoint:');
    console.log(`  cloudflared tunnel --url http://localhost:${PORT}   (or: ngrok http ${PORT})`);
  });
