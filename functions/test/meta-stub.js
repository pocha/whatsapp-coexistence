// A minimal stand-in for graph.facebook.com, used only in tests via the
// GRAPH_API_BASE env override (see src/helpers/graphApi.ts). Lets integration tests
// exercise the real HTTP functions end-to-end without hitting real Meta.
const http = require('node:http');

function startMetaStub(port) {
  // Every request the stub got, so a test can check that something was (or was not) called.
  const calls = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/__calls') {
      res.writeHead(200).end(JSON.stringify(calls));
      return;
    }
    calls.push(`${req.method} ${req.url}`);

    if (req.method === 'GET' && req.url.startsWith('/oauth/access_token')) {
      res.writeHead(200).end(JSON.stringify({ access_token: 'stub-access-token' }));
      return;
    }

    // Stands in for the business's own incoming-message endpoint: echoes the
    // challenge back, like a correctly set up webhook does.
    if (req.method === 'GET' && req.url.startsWith('/business-endpoint')) {
      const challenge = new URL(req.url, 'http://x').searchParams.get('hub.challenge');
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(200).end(challenge);
      return;
    }

    // The business endpoint also takes the test events the wizard posts to it.
    if (req.method === 'POST' && req.url.startsWith('/business-endpoint')) {
      res.writeHead(200).end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/subscribed_apps')) {
      res.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }

    // Number info. 222 is also on the WhatsApp Business app (coexistence); any other number is not.
    const info = req.url.match(/^\/(\d+)\?fields=status,code_verification_status,is_on_biz_app,platform_type/);
    if (req.method === 'GET' && info) {
      const onApp = info[1] === '222';
      res.writeHead(200).end(
        JSON.stringify({ id: info[1], status: 'CONNECTED', code_verification_status: 'VERIFIED', is_on_biz_app: onApp, platform_type: 'CLOUD_API' }),
      );
      return;
    }

    // Registering: 229 is refused (a wrong PIN, say), the rest work.
    if (req.method === 'POST' && req.url.match(/^\/\d+\/register$/)) {
      if (req.url === '/229/register') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'meta-stub: wrong PIN' } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }

    if (req.method === 'POST' && req.url.match(/^\/\d+\/deregister$/)) {
      res.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }

    // Coexistence sync requests: 230 fails.
    if (req.method === 'POST' && req.url.match(/^\/\d+\/smb_app_data$/)) {
      if (req.url === '/230/smb_app_data') {
        res.writeHead(500).end(JSON.stringify({ error: { message: 'meta-stub: sync failed' } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ messaging_product: 'whatsapp', request_id: 'stub' }));
      return;
    }

    // A Messaging account read (the check that we can reach the previous provider's account):
    // 99999999 can't be read, the rest can.
    const account = req.url.match(/^\/(\d+)\?fields=id$/);
    if (req.method === 'GET' && account) {
      if (account[1] === '99999999') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'meta-stub: no access' } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ id: account[1] }));
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/migrate_message_templates')) {
      res.writeHead(200).end(JSON.stringify({ migrated_templates: ['1', '2', '3'], failed_templates: { 4: 'Incorrect category' } }));
      return;
    }

    // Sends and template calls must carry the Meta token the functions decrypted
    // (not the customer's Watobot API key).
    const onMetaToken = req.headers.authorization === 'Bearer stub-access-token';

    if (req.method === 'POST' && req.url.endsWith('/messages')) {
      if (!onMetaToken) {
        res.writeHead(401).end(JSON.stringify({ error: { message: 'meta-stub: wrong token' } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ messages: [{ id: 'wamid.stub-message-id' }] }));
      return;
    }

    if (req.url.includes('/message_templates')) {
      if (!onMetaToken) {
        res.writeHead(401).end(JSON.stringify({ error: { message: 'meta-stub: wrong token' } }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200).end(JSON.stringify({ data: [{ id: '1', name: 'stub_template', status: 'APPROVED' }] }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ id: '2', status: 'PENDING', category: 'UTILITY' }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: `meta-stub: no handler for ${req.method} ${req.url}` }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startMetaStub };
