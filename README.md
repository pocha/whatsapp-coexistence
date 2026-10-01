# WhatsApp Coexistence

Lets a business run the WhatsApp Business app and the WhatsApp API on the same
number at once ("coexistence"). The frontend (`public/`, generated from
`views/`) is static and deployed to GitHub Pages. The backend (`functions/`) is
Firebase Functions, Firestore and Firebase Auth.

## Setup

### 1. Business Portfolio

Create one by following the guide:
[How to Create a Meta Business Portfolio & Add Your WhatsApp Number](https://watobot.com/how-to/business-portfolio.html).

### 2. Meta app

Create the app by following
[How to Get WhatsApp API for Free](https://watobot.com/how-to/meta-app.html)
(the app-creation steps; you don't need its access token section).

Then collect three values:

- **App ID** and **App Secret**: in the app, go to **App settings → Basic**.
  Put the App ID in `public/assets/app-config.js` as `META_APP_ID` and the
  App Secret in `functions/.env` (step 3).
- **Embedded Signup Configuration ID**, created as follows. Configurations live
  under **Facebook Login for Business → Configurations**.

  1. Click **Create configuration**.

     ![Configurations screen with the Create configuration button](public/assets/10.create-configuration.png)

  2. **Name**: anything. **Login variation**: **WhatsApp Embedded Signup**.
  3. **Products**: check only **WhatsApp Cloud API**.

     ![Products step with only WhatsApp Cloud API checked](public/assets/11.choose-products.png)

  4. **Access token**: **User access token**, with expiration **Never**. The
     business keeps this token and uses it to send messages (we never store it),
     so a 60-day expiry would break their integration every two months.

     ![Access token step: User access token (the screenshot shows 60 days; choose Never)](public/assets/12.access-token-selection.png)

  5. **Assets**: **WhatsApp accounts**, with the task permission **MANAGE**.

     ![Assets step showing WhatsApp accounts as the only asset type](public/assets/13.assets.png)

  6. **Permissions**: `whatsapp_business_management` and
     `whatsapp_business_messaging`.

     ![Permissions step](public/assets/14.permissions.png)

  7. Save, and put the **Configuration ID** in `public/assets/app-config.js` as
     `META_CONFIG_ID`.

Running Embedded Signup for real customers also needs this app to be an
approved Meta Tech Provider. Until then, only people with a role on the app
can use it.

### 3. Local setup

Prerequisites: Node 24 and the Firebase CLI (`npm i -g firebase-tools`).

```bash
npm install
cd functions && npm install && cp .env.example .env
```

Fill in `functions/.env`:

```
META_APP_ID=<your App ID>
META_APP_SECRET=<your App Secret>
WEBHOOK_VERIFY_TOKEN=<any string you make up>
WATOBOT_API_KEY=<your watobot API key>
```

`WATOBOT_API_KEY` is used to send the login OTP over WhatsApp through
[watobot](https://github.com/pocha/mudbot). `.env` is gitignored, so don't
commit it.

Run the tests, from `functions/`:

```bash
npm test                  # unit tests, then emulator-backed integration tests
npm run test:unit         # fast, no emulator
npm run test:integration  # real Firestore/Auth/Functions emulators
```

Run the app, from the repo root:

```bash
npm start
```

This builds the pages, serves them at `http://localhost:8765/dashboard/`, and
starts the Functions, Firestore and Auth emulators. Use `localhost`, not
`127.0.0.1`, because Meta's domain checks treat them as different domains.
`Ctrl+C` stops everything. Emulator UI: `http://127.0.0.1:4000`.

Things to know:

- Firestore and Auth are emulated, so local sign-ins are emulator-only users.
- `sendOtp` sends a real WhatsApp message through watobot, even locally.
- Embedded Signup talks to Facebook's real servers, so real values in
  `functions/.env` and `app-config.js` are needed to try it.
- In your Meta app, add `localhost` to **App Domains** and to **Allowed
  Domains for the JavaScript SDK**.

Check the app locally by signing in at `http://localhost:8765/dashboard/` with
a number you own, entering the WhatsApp OTP you receive.

### 4. Production deployment

**Frontend (GitHub Pages).** In the repo, go to **Settings → Pages → Source:
GitHub Actions**. Every push to `main` that touches `public/`, `views/` or
`scripts/build-pages.js` runs `.github/workflows/deploy-pages.yml`, which builds
the pages and publishes `public/`. The generated HTML is not committed. Set a
custom domain in the same Pages settings if you want one. The site's links
assume it is served from the root of its domain.

**Backend (Firebase).**

1. Create a Firebase project and upgrade it to the Blaze plan (Functions need
   it to make outbound calls). Enable **Firestore**. Custom-token sign-in needs
   no provider toggle.
2. Point the repo at your project: set the project id in `.firebaserc`, and the
   web config and Functions URL in `public/assets/firebase-init.js`.
3. Make sure `functions/.env` is filled in. `firebase deploy` packages the file
   as it sits on disk.
4. Deploy:

   ```bash
   firebase login
   firebase deploy --only firestore          # rules and indexes
   cd functions && npm run deploy            # builds, then deploys the Functions
   ```

### 5. Test onboarding a WABA locally

You need the pieces from steps 1 to 3, a spare phone number registered on the
WhatsApp Business app, and an app of yours (a chatbot) reachable at a public
HTTPS URL. For a quick test, run a small local server and put a tunnel such as
ngrok or cloudflared in front of it. It must answer Meta's GET handshake by
echoing back the `hub.challenge` value, and log incoming POSTs.

1. In the Meta app, confirm Access Verification is cleared. While it is
   pending, Embedded Signup fails with "App not active".
2. `npm start` and open `http://localhost:8765/dashboard/`.
3. Sign in with a number you own and the OTP sent to it.
4. Click **Onboard a WABA** and complete Meta's popup with the spare number. You
   must have a role on the Meta app. For a number on the Business app, Meta
   sends a verification code to the Business app, with a **Connect** button.
5. Step 2: enter your tunnel URL and click **Test endpoint & activate**.
6. Step 3: copy the access token. It is shown once and not stored.
7. From another phone, send a WhatsApp message to the number. It should appear in
   your endpoint's log.
8. Reply through the relay (free-form text only works within 24 hours of the
   customer's last message, so do step 7 first):

   ```bash
   curl -X POST \
     "http://127.0.0.1:5001/wa-coexistence/us-central1/relayMessage/<phoneNumberId>/messages" \
     -H "Authorization: Bearer <your access token>" \
     -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","to":"<recipient>","type":"text","text":{"body":"Hello!"}}'
   ```

Known gaps that may show up here:

- The wizard only listens for Meta's `FINISH` message event. The Business-app
  flow may send a differently named event (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`),
  in which case step 1 won't complete. Check the browser console.
- Meta's coexistence docs also require the `smb_app_state_sync` and
  `smb_message_echoes` webhooks and a history sync within 24 hours. This app
  doesn't do those yet.
