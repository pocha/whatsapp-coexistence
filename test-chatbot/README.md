# Test chatbot

A minimal echo chatbot for trying WA Coexistence end to end when you don't have
an app of your own that uses the WhatsApp API. It has no dependencies.

It does three things:

- Answers Meta's verification handshake (`GET /webhook`), which is what the
  "Verify & save" button on a WABA's page calls before it accepts your URL.
- Logs every event WhatsApp sends to it (`POST /webhook`).
- Replies "You said: ..." to each text message, through our relay.

## Set it up

You need Node 24.

```bash
cd test-chatbot
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|---|---|
| `WEBHOOK_VERIFY_TOKEN` | The same value as `WEBHOOK_VERIFY_TOKEN` in `functions/.env`. |
| `ACCESS_TOKEN` | The access token shown once when you onboard a WABA. Leave it empty for now and add it later (see below). |
| `RELAY_BASE` | Optional. Where replies are sent. The default is the local Functions emulator, `http://127.0.0.1:5001/wa-coexistence/us-central1/relayMessage`, which needs the main app's `npm start` running. For the deployed backend use `https://us-central1-<project-id>.cloudfunctions.net/relayMessage`. |

Start it:

```bash
npm start
```

It listens on `http://localhost:3000/webhook`. Without an `ACCESS_TOKEN` it
still logs messages, but doesn't reply.

## Give it a public HTTPS URL

Meta calls your URL directly from its servers, and we only accept HTTPS URLs, so
`localhost` won't do. Put a tunnel in front of the bot, in a second terminal:

```bash
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:3000
```

(`ngrok http 3000` works too.) Your incoming-message URL is the printed
`https://....trycloudflare.com` address plus `/webhook`, for example
`https://random-words.trycloudflare.com/webhook`. A free tunnel gets a new
address each time you start it, so update the URL on the WABA's page if you
restart the tunnel.

## Use it

1. Enter the tunnel URL as the incoming-message URL on the WABA's page
   (`/waba.html?id=<wabaId>`). The bot's terminal prints
   `GET /webhook handshake: ok`.
2. Put the access token in `.env` as `ACCESS_TOKEN` and restart the bot
   (`Ctrl+C`, then `npm start`) so it can reply.
3. Send a WhatsApp message to the number from another phone. The bot logs the
   event and replies "You said: ...".

## Notes

- Only `text` messages get a reply. Other events are logged and ignored,
  including `smb_message_echoes` (your own messages sent from the Business
  app), so the bot never answers itself.
- The bot answers Meta right away and does its work afterwards, because Meta
  retries slow responses.
- Free-form replies only work within 24 hours of the customer's last message.
  Replying to a message that just arrived is always inside that window.
- This is a test tool. It has no signature checking on incoming requests and
  keeps your access token in a local `.env` file (gitignored). Don't expose it
  longer than you need to.
