# WhatsApp Coexistence — Onboarding App

A minimal Node.js + TypeScript app for becoming a Meta **Tech Provider** and
onboarding businesses onto **WhatsApp Coexistence**: it runs Embedded Signup,
then subscribes to the new WABA — optionally overriding the webhook straight
to the customer's own server, so this app doesn't sit in the message path
afterward.

It also ships two "test" features (send a message, create a template) that
exist **only** to satisfy Meta's App Review video requirements. They're not
part of the onboarding product itself — see [step 3](#3-record-your-app-review-videos)
below.

## 1. Set up your Meta App

You need a Meta App with Tech Provider access before any of this works.

### Business Portfolio (do this first)

The app-creation flow will ask you to connect a Business Portfolio. Don't
pick your personal profile if it shows up as an option — Business
Verification (required for Tech Provider status) needs a real legal
business behind the portfolio, not an individual account.

1. Go to [business.facebook.com](https://business.facebook.com/) and create
   a Business Portfolio if you don't already have one (or click **"Create a
   business portfolio"** from the app-creation screen itself).
2. Fill in your **legal business name**, business email, and business
   address — use the details that match your registration documents, since
   these get checked during verification.
3. Once created, go to **Business Settings → Security Center → Business
   verification** (or the prompt on the portfolio's home page) and start
   verification. You'll need documents such as a business registration
   certificate / tax ID, and Meta may verify by document upload, a phone
   call, or a domain check, depending on your business.
4. Verification can take anywhere from a few minutes to several days.
   You can create the Meta App and start local development before it
   completes — you'll just need it finished before submitting for **App
   Review** / Tech Provider approval.

### Create the app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create a new App.
2. When asked what you want your app to do, choose the **"Connect with
   customers through WhatsApp"** use case (not "Create an app without a use
   case" or "Other") — this adds the WhatsApp product and the
   `whatsapp_business_messaging` / `whatsapp_business_management`
   permissions automatically.
3. On the **Business** step, select the Business Portfolio you created
   above (not your personal profile) and continue.
4. Go to **App Settings → Basic** and note down the **App ID** and **App Secret**.
5. Go to **WhatsApp → Configuration → Embedded Signup** and create a signup
   configuration (this defines what the Embedded Signup popup shows the
   customer — business verification requirements, feature type, etc). Note
   the **Configuration ID**.
6. Your app is in **Development Mode** by default, which is enough to record
   the review videos in step 3. You only need to submit for **App Review**
   (Business Verification + `whatsapp_business_management` and
   `whatsapp_business_messaging` permissions) once you're ready to onboard
   real customers.
7. Separately, apply for **Tech Provider** status: Meta grants this alongside
   or after App Review — there's no separate self-serve toggle. Submit the
   App Review request above and Meta's review covers both.

## 2. Run the app

Requires Node 18+.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `META_APP_ID` | App Dashboard → App Settings → Basic |
| `META_APP_SECRET` | App Dashboard → App Settings → Basic |
| `META_CONFIG_ID` | App Dashboard → WhatsApp → Embedded Signup config |
| `META_WEBHOOK_VERIFY_TOKEN` | Any string you make up — used to verify webhook calls are from your own setup |
| `BASE_URL` | Your public HTTPS URL (see below). Optional — only pre-fills a UI field. |

You need a **public HTTPS URL** for Meta to redirect to and call your
webhook — `localhost` won't work. Point your existing domain at this app
(reverse proxy to `PORT`, default `3000`), or for local dev use a tunnel like
`ngrok http 3000`.

Then:

```bash
npm run dev     # TypeScript, auto-reload
# or
npm run build && npm start   # compiled, for a real deploy
```

Open your public URL in a browser. In the App Dashboard, also set your
webhook URL to `https://<your-domain>/webhook` with the same verify token,
and subscribe to the `messages` field, so the "Incoming webhook events" panel
can show activity.

## 3. Record your App Review videos

Meta's App Review requires **two videos** before it approves the
`whatsapp_business_messaging` and `whatsapp_business_management` permissions
(and with them, Tech Provider status). A pure onboarding-only app can't
produce these on its own — that's what the test panel on the page is for.

**Video 1 — send a message, created and sent from your app**
1. Click **Login with Facebook** and complete Embedded Signup for a test
   business (use a test WABA/number — see Meta's WhatsApp test number docs
   if you don't have one).
2. Click **Complete onboarding** (leave the override URL blank so this app
   keeps receiving events for the demo).
3. In the "Send a test message" form, enter a recipient number and click
   **Send message**. Show the message being created in your app and arriving
   in the WhatsApp client on the recipient's phone.

**Video 2 — your app creating a message template**
1. In the "Create a message template" form, fill in a name/category/body and
   click **Create template**.
2. Show the response, then show the new template listed in the Meta Business
   Manager (WhatsApp Manager → Message Templates) for that WABA.

Keep both recordings simple and unedited — reviewers are checking that the
flow (login → action → result) is real and complete, not evaluating UI
polish.

## 4. After approval

Once approved, the send-message/create-template buttons aren't needed
anymore — they hold WABA access tokens in memory to work, which is more
exposure than the real onboarding flow needs. Either:

- Set `ENABLE_TEST_FEATURES=false` in `.env` (disables the routes and stops
  storing tokens after onboarding), or
- Delete `src/routes/test.ts` and its registration in `src/server.ts`
  entirely.

The onboarding endpoint (`POST /api/onboarding/complete`) discards the
access token immediately after calling `subscribed_apps` when test features
are off — it's only held in memory for the length of that one request.

## How it works

- `public/index.html` + `public/app.js` — loads the Facebook JS SDK, runs
  `FB.login()` with your Embedded Signup config, and captures the resulting
  `code` + the new WABA/phone number ids from the `WA_EMBEDDED_SIGNUP`
  postMessage event.
- `POST /api/onboarding/complete` — exchanges the `code` for an access token,
  then calls `POST /{waba-id}/subscribed_apps`, optionally with
  `override_callback_uri` set to the customer's own webhook.
- `GET /webhook` / `POST /webhook` — Meta's webhook verification handshake
  and event receiver, for WABAs that weren't overridden elsewhere.
- `src/routes/test.ts` — the send-message / create-template demo endpoints
  described above.

## Security notes

- The WABA access token issued during Embedded Signup **never expires**
  until revoked in Business Manager. Don't log it, don't persist it anywhere
  durable, and turn off the test features (which hold it in memory) once
  you're done with App Review.
- Always run this over HTTPS in any real deployment — Meta requires it for
  the OAuth redirect and webhook anyway.
