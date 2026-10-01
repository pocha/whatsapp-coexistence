// A minimal stand-in for graph.facebook.com, used only in tests via the
// GRAPH_API_BASE env override (see src/graphApi.ts). Lets integration tests
// exercise the real HTTP functions end-to-end without hitting real Meta.
const http = require('node:http');

function startMetaStub(port) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

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

    // GET /{waba-id}?fields=id with a bearer token
    if (req.method === 'GET' && /^\/[^/?]+\?fields=id/.test(req.url)) {
      if (req.headers.authorization === 'Bearer valid-user-token') {
        res.writeHead(200).end(JSON.stringify({ id: req.url.split('?')[0].slice(1) }));
      } else {
        res.writeHead(401).end(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }));
      }
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/subscribed_apps')) {
      res.writeHead(200).end(JSON.stringify({ success: true }));
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/messages')) {
      res.writeHead(200).end(JSON.stringify({ messages: [{ id: 'wamid.stub-message-id' }] }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: `meta-stub: no handler for ${req.method} ${req.url}` }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startMetaStub };
