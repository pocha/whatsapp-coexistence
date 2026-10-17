import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyEndpointChallenge } from './endpointCheck';

// A stand-in for a customer's endpoint. The integration runner sets ALLOW_HTTP_ENDPOINT for the
// same reason: the real check only accepts public HTTPS addresses.
let server: http.Server;
let base: string;

before(async () => {
  process.env.ALLOW_HTTP_ENDPOINT = 'true';
  server = http.createServer((req, res) => {
    const challenge = new URL(req.url!, 'http://x').searchParams.get('hub.challenge');
    res.writeHead(200).end(req.url!.startsWith('/echo') ? challenge : 'something else');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  delete process.env.ALLOW_HTTP_ENDPOINT;
  server.close();
});

test('an endpoint that echoes the challenge passes', async () => {
  assert.deepEqual(await verifyEndpointChallenge(`${base}/echo`, 'token'), { ok: true });
});

test('an endpoint that does not echo the challenge fails, and says what it answered', async () => {
  const result = await verifyEndpointChallenge(`${base}/other`, 'token');
  assert.equal(result.ok, false);
  assert.match(result.error!, /something else/);
});
