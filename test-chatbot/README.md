# Test chatbot

A tiny chatbot for trying WA Coexistence when you don't have an app of your own
that uses the WhatsApp API. It answers Meta's verification handshake and logs
every incoming message. Add your access token and it also replies "You said:
..." to text messages through our relay. It has no dependencies.

## Setup

1. Install [Node.js](https://nodejs.org/) 20.6 or newer. npm comes with it.
2. Run `npm install`. It installs the dependencies, including `cloudflared`,
   which gives the bot its public HTTPS URL.
3. Copy `.env.example` to `.env` (`cp .env.example .env`, or `copy` on Windows),
   and fill it in with the values from the **Using the test chatbot?** box on
   your WABA's page on Watobot (the page that sent you here).
4. Run `npm start`. It launches the server and prints your webhook URL:

   ```
   Tunnel is up. Use this as your incoming-message URL:

     https://random-words.trycloudflare.com/webhook
   ```

   Enter that URL as the incoming-message URL on the Watobot page. The bot
   prints `GET /webhook handshake: ok` when Meta checks it.

## Use it

Keep the server running. Now send a WhatsApp message to your WABA's registered
phone number from another phone, and the message shows up in the bot's logs.

To have it reply too, put your access token in `.env` as `ACCESS_TOKEN` and
restart the bot.

`Ctrl+C` stops the bot and the tunnel. The tunnel address changes each time you
start it, so update the URL on your WABA's page after a restart.

## Notes

- Replies go through the relay at `RELAY_BASE`. For a local backend that means
  the main app's `npm start` must be running.
- Only text messages get a reply. Other events are logged and ignored, including
  your own messages sent from the Business app, so the bot never answers itself.
- Free-form replies only work within 24 hours of the customer's last message.
- It's a test tool: it doesn't check request signatures, and it keeps your access
  token in a local, gitignored `.env`.
