// A minimal stand-in for graph.facebook.com, used only in tests via the
// GRAPH_API_BASE env override (see src/helpers/graphApi.ts). Lets integration tests
// exercise the real HTTP functions end-to-end without hitting real Meta.
const http = require('node:http');

function startMetaStub(port) {
  // Every request the stub got, so a test can check that something was (or was not) called.
  const calls = [];
  let granted = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/__calls') {
      res.writeHead(200).end(JSON.stringify(calls));
      return;
    }
    calls.push(`${req.method} ${req.url}`);

    // A signup code of the form c:<WABA ID> grants that WABA to the token it is exchanged for.
    // (Tests run one signup at a time, so the last grant is the one debug_token reports.)
    if (req.method === 'GET' && req.url.startsWith('/oauth/access_token')) {
      const grant = new URL(req.url, 'http://x').searchParams.get('code')?.match(/^c:(\d+)$/);
      granted = grant ? grant[1] : null;
      res.writeHead(200).end(JSON.stringify({ access_token: 'stub-access-token' }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/debug_token')) {
      res.writeHead(200).end(
        JSON.stringify({ data: { is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: granted ? [granted] : [] }] } }),
      );
      return;
    }

    // A WABA's phone numbers: WABA 9<n> holds number <n> (and 111 holds 222). WABA 9777 can't be read.
    const numbersOfWaba = req.url.match(/^\/(\d+)\/phone_numbers\?/);
    if (req.method === 'GET' && numbersOfWaba) {
      if (numbersOfWaba[1] === '9777') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'meta-stub: cannot list' } }));
        return;
      }
      const own = numbersOfWaba[1] === '111' ? '222' : numbersOfWaba[1].slice(1);
      res.writeHead(200).end(JSON.stringify({ data: [{ id: own }] }));
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

    if ((req.method === 'POST' || req.method === 'DELETE') && req.url.endsWith('/subscribed_apps')) {
      res.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }

    // Number info. 222, 2280 and 2283 are also on the WhatsApp Business app (coexistence); any other number is not.
    const info = req.url.match(/^\/(\d+)\?fields=status,code_verification_status,is_on_biz_app,platform_type/);
    if (req.method === 'GET' && info) {
      const onApp = info[1] === '222' || /^228[03]$/.test(info[1]);
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

    // Live details for getNumber: any field read of a number or account, and the subscribed apps.
    if (req.method === 'GET' && req.url.match(/^\/\d+\/subscribed_apps$/)) {
      res.writeHead(200).end(JSON.stringify({ data: [{ id: '1323887826398640', name: 'stub-app', override_callback_uri: 'https://example.com/hook' }] }));
      return;
    }
    if (req.method === 'GET' && req.url.match(/^\/\d+\?fields=[a-z_,]+$/) && !req.url.includes('ownership_type')) {
      res.writeHead(200).end(
        JSON.stringify({ display_phone_number: '+1 555-000-0000', quality_rating: 'GREEN', status: 'CONNECTED', name: 'stub-account', whatsapp_business_manager_messaging_limit: 'TIER_250' }),
      );
      return;
    }
    if (req.method === 'GET' && req.url.match(/^\/\d+\?fields=ownership_type/)) {
      res.writeHead(400).end(JSON.stringify({ error: { message: 'meta-stub: ownership not readable' } }));
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
