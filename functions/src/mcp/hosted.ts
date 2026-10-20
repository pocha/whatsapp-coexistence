import { onRequest } from 'firebase-functions/v2/https';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hashApiKey, isValidApiKey } from '../helpers/apiKey';
import { userIdByKeyHash } from '../helpers/model';
import { DEFAULT_API, DEFAULT_SITE } from './api';
import { createServer } from './tools';

// The hosted MCP server, for AI tools that connect to an address instead of launching a program
// (claude.ai, ChatGPT, and Claude Code or Cursor over http). The caller's API key is the
// credential, either as `Authorization: Bearer <key>` or as the path, /mcp/<key>, for tools that
// only take an address. There is no OAuth: the key is what the rest of Watobot already uses.
//
// Stateless: every request gets its own server, so nothing about a caller is kept between calls.
// The key is never logged here, and Cloud Run's request log records the address it came in on, so
// the README says to exclude this function's requests from it.

const emulated = process.env.FUNCTIONS_EMULATOR === 'true';
const apiBase = emulated ? 'http://127.0.0.1:5001/wa-coexistence/us-central1' : DEFAULT_API;
const siteUrl = emulated ? 'http://localhost:8765' : DEFAULT_SITE;

function keyOf(req: { header(name: string): string | undefined; path: string }): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
  return bearer?.[1] ?? (req.path.replace(/^\/|\/$/g, '') || undefined);
}

export const mcp = onRequest({ timeoutSeconds: 300 }, async (req, res) => {
  const key = keyOf(req);
  const userId = isValidApiKey(key) ? await userIdByKeyHash(hashApiKey(key)) : undefined;
  if (!isValidApiKey(key) || !userId) {
    res.set('WWW-Authenticate', 'Bearer').status(401).send({ error: 'Missing or incorrect Watobot API key. Use Authorization: Bearer <key>, or the connector address from the API key page.' });
    return;
  }
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    return;
  }

  const server = createServer({ key: () => key, apiBase, siteUrl });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
