// The built file starts, answers an MCP handshake and lists its tools. The tools themselves are
// tested in functions/src/mcp/tools.test.ts, which is where their code lives.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const child = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, WATOBOT_API_KEY: '' } });
const lines = [];
let buffer = '';
child.stdout.on('data', (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    lines.push(JSON.parse(buffer.slice(0, i)));
    buffer = buffer.slice(i + 1);
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const reply = async (id) => {
  for (let i = 0; i < 100; i++) {
    const found = lines.find((l) => l.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no answer to ${id}`);
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
assert.equal((await reply(1)).result.serverInfo.name, 'watobot');
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.ok((await reply(2)).result.tools.length >= 19);
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_numbers', arguments: {} } });
const call = await reply(3);
assert.equal(call.result.isError, true);
assert.match(call.result.content[0].text, /Sign up at https:\/\/watobot\.com/);
child.kill();
console.log('ok: starts, lists its tools, and tells a new user how to get a key');
