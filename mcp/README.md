# watobot-mcp

An [MCP](https://modelcontextprotocol.io) server for [Watobot](https://watobot.com). It lets an AI tool onboard a WhatsApp number to the WhatsApp Cloud API while the number stays on the WhatsApp Business app (coexistence), and then run it: send messages, manage templates, and see why sending is held back.

You need a Watobot account and an API key. Sign up at https://watobot.com and create the key on the **API key** page. It is made in your browser and shown once.

## Install

**Claude Code**

```bash
claude mcp add watobot -e WATOBOT_API_KEY=<your key> -- npx -y watobot-mcp
```

**Claude Desktop, Cursor and other tools that start a program** (needs Node.js 20 or newer). Add this to the tool's MCP settings and restart it:

```json
{ "mcpServers": { "watobot": {
    "command": "npx",
    "args": ["-y", "watobot-mcp"],
    "env": { "WATOBOT_API_KEY": "<your key>" }
} } }
```

**claude.ai and ChatGPT** connect from their own servers, so they use Watobot's hosted MCP address instead of this package. The API key page on watobot.com builds it for you.

Step by step: https://watobot.com/how-to/connect-watobot-to-ai-tool.html

## What it can do

Ask your AI tool, for example: *Use Watobot to onboard my WhatsApp number with coexistence. My endpoint is https://example.com/webhook.*

- **Onboard:** check a callback URL, send test events, get the link for Meta's sign-up, follow each number's next step (sync, register, templates).
- **Send:** messages through Watobot, with the room left under the rate limits.
- **Templates:** list, create, delete, migrate from a previous provider, import from an export.
- **Status:** a number's state, why sending is limited or blocked and what to do about it, and the notifications Meta has sent.
- **Leave:** de-register or disconnect a number.

`deregister_number`, `disconnect_number`, `delete_template` and `skip_sync` cannot be undone. They are marked destructive, and a good client asks you first.

Meta's sign-up (Facebook login, the WhatsApp Business app's code or QR) always happens in your browser. No tool can do it for you.

## Configuration

| Variable | |
| --- | --- |
| `WATOBOT_API_KEY` | Your Watobot API key. Without it every tool says how to get one. |
| `WATOBOT_API_URL` | Optional. Overrides the Watobot API address. |
| `WATOBOT_SITE_URL` | Optional. Overrides the address used in sign-up links. |

The key is only ever sent to Watobot. It is never logged and never returned in a tool's answer.

## Licence

MIT
