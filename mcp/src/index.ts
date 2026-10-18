#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_API, DEFAULT_SITE, keyFromValue } from '../../functions/src/mcp/api';
import { createServer } from '../../functions/src/mcp/tools';

// The local server: an AI tool launches this program, and the key comes from its environment. The
// tools themselves are the same ones the hosted server (functions/src/mcp/hosted.ts) offers.
const siteUrl = (process.env.WATOBOT_SITE_URL ?? DEFAULT_SITE).replace(/\/$/, '');
const apiBase = (process.env.WATOBOT_API_URL ?? DEFAULT_API).replace(/\/$/, '');

await createServer({ key: () => keyFromValue(process.env.WATOBOT_API_KEY, siteUrl), apiBase, siteUrl }).connect(new StdioServerTransport());
