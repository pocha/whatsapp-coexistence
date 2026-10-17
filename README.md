# WhatsApp Coexistence

Lets a business run the WhatsApp Business app and the WhatsApp API on the same
number at once ("coexistence"). The frontend is static and deployed to GitHub Pages: pages are
generated from `views/` and the browser scripts are TypeScript in `src/`, both built
into `public/` (`npm run build:pages`; `npm run typecheck` checks the types). The backend (`functions/`) is
Firebase Functions, Firestore and Firebase Auth.

## API

Everything is a Firebase HTTPS function. The base URL is `https://us-central1-wa-coexistence.cloudfunctions.net`, and a function's path is its name (`/setWebhook`), except the two that serve several routes: `relayMessage` and `templates`. Answers are JSON with `ok` (and `error` when `ok` is false), except the relay and the template list/create/edit/delete, which return Meta's response unchanged.

Three kinds of credential:
- **Key**: the Watobot API key, as `Authorization: Bearer <key>` (relay and templates) or as `apiKey` in the body (the rest). It is checked against the account, then used to open the stored Meta token for that one request.
- **Signed in**: a Firebase ID token, `Authorization: Bearer <id token>`. Used by the dashboard.
- **None**: anyone, or Meta.

**Messaging and templates** (for customers' apps; the key is the bearer token; `<id>` is the phone number ID)

| Method and path | What it does | Body |
| --- | --- | --- |
| `POST /relayMessage/<id>/messages` | Sends a message through Meta with the stored token. Template sends are rate limited: a refused one gets 429 with `Retry-After`, and every template send answers with `X-RateLimit-Remaining-<Minute|Hour|Day>` and `X-RateLimit-Reset-<...>` (epoch seconds). | Meta's messages body |
| `GET /relayMessage/<id>/limits` | Where the number stands against its template-send limits, per minute, hour and day window: accepted, attempted, previous window's count, limit, remaining and when it resets. Free-form messages are not limited. | |
| `GET /templates/<id>` | Lists the account's templates (id, name, status, category, language, components). The response is what `/import` takes. | |
| `POST /templates/<id>` | Creates a template. | Meta's template body |
| `POST /templates/<id>/<templateId>` | Edits a template. | Meta's template body |
| `DELETE /templates/<id>?name=<name>` | Deletes every template with that name. | |
| `POST /templates/<id>/migrate` | Copies approved templates from a previous Messaging account (Watobot must be a partner on it). Answers `outcome: "unreadable"` if we can't read it. | `{ sourceWabaId }` |
| `POST /templates/<id>/import` | Creates templates from an exported list, up to 100 at a time. | `{ templates }` |

**A number** (key in the body: `phoneNumberId` and `apiKey` in every one)

| Method and path | What it does | Other body fields |
| --- | --- | --- |
| `POST /setWebhook` | Checks the URL answers Meta's handshake, subscribes to it, and records it. During onboarding it also moves the wizard on. | `overrideCallbackUrl` |
| `POST /registerNumber` | Registers an API-only number. Refused for a number on the WhatsApp Business app. | `pin` (6 digits) |
| `POST /deregisterNumber` | Takes an API-only number off the Cloud API. Refused for a number on the Business app (disconnect there). | |
| `POST /disconnectNumber` | What leaving Watobot does on Meta's side: unsubscribes our app, and de-registers an API-only number if asked. | `deregister` (boolean) |

**Onboarding** (the wizard)

| Method and path | Credential | What it does | Body |
| --- | --- | --- | --- |
| `POST /checkCallbackUrl` | Signed in or key | Does Meta's handshake against a callback URL, before there is a number. | `overrideCallbackUrl` |
| `POST /sendTestEvents` | Signed in or key | Posts one test webhook of each kind to a URL, with fresh codes. One send per 30 seconds. | `overrideCallbackUrl` |
| `POST /verifyTestCodes` | Signed in or key | Says which of the four typed codes match the last send. | `codes` |
| `POST /exchangeCode` | Signed in + `apiKey` | Exchanges the Embedded Signup code for the Meta token, stores it encrypted under the key, and starts the wizard for the number. | `code`, `wabaId`, `phoneNumberId`, `apiKey`, `event` |
| `POST /startSync` | Key | Requests the contacts, then the history sync (each once). | `phoneNumberId`, `apiKey`, `syncType` |
| `POST /setOnboardingStep` | Key | Moves the wizard between the steps the user chooses or confirms. | `phoneNumberId`, `apiKey`, `step` |

**Account**

| Method and path | Credential | What it does | Body |
| --- | --- | --- | --- |
| `POST /sendOtp` | None | Sends a sign-in code on WhatsApp. | `phone` |
| `POST /verifyOtp` | None | Checks the code and signs in (or resets a lost key). | `phone`, `code`, `apiKey?`, `resetApiKey?` |
| `POST /listNumbers` | Signed in or key | The account's numbers: where each is in onboarding (`step`), whether it is on the Business app, the syncs, usage. Never the stored token (`hasToken` only). | (`apiKey` for a key) |
| `POST /getNumber` | Signed in or key | One number, as above, plus its template-send limits. 404 for a number that is not the caller's. | `phoneNumberId` |
| `POST /rotateKey` | Signed in | Replaces the API key and re-encrypts every stored token. | `oldApiKey`, `newApiKey` |
| `POST /joinWaitlist` | None | Counts a waitlist click. | |

**Meta calls this one**

| Method and path | What it does |
| --- | --- |
| `GET /webhook` | Answers Meta's verification handshake. |
| `POST /webhook` | Receives the webhooks that can't be overridden (template and account-level updates). Checks Meta's `X-Hub-Signature-256` (an HMAC of the body with the app secret), refuses anything else with 401, and acknowledges the rest. Nothing is done with them yet: Meta emails the account's admins about the ones that matter. |

The request bodies are typed in `functions/src/helpers/types.ts`.

## MCP server

`mcp/` is a small MCP server (package `watobot-mcp`) that lets an AI tool use the functions above: check a callback URL, send test events, get the link for Meta's sign-up, read a number's state, sync, register, send messages, manage templates, de-register and disconnect. It runs locally over stdio and holds the API key only in its environment.

```bash
claude mcp add watobot -e WATOBOT_API_KEY=<your key> -- npx -y watobot-mcp
```

A new user signs up on the site and creates the key there (it is made in the browser and shown once, so no tool can make it). Meta's sign-up (Facebook login, the code or QR in the WhatsApp Business app) is always done by the person: the `start_onboarding_link` tool gives a link that opens the dashboard wizard at that step, with the checks already done. `deregister_number`, `disconnect_number` and `delete_template` are marked destructive.

Develop it with `cd mcp && npm test`. `WATOBOT_API_URL` points it at the emulators (`http://127.0.0.1:5001/wa-coexistence/us-central1`).

## Roadmap

What is built and what is next is in [roadmap.md](roadmap.md), with the Meta behaviours we rely on and the open questions.

## Setup

### 1. Business Portfolio

Create one by following steps 1 to 3 of the guide:
[How to Create a Meta Business Portfolio & Add Your WhatsApp Number](https://watobot.com/how-to/create-meta-business-portfolio-add-whatsapp-number.html).

Stop after step 3. Skip steps 4 and 5 (adding a WhatsApp account and an app):
that guide is written for people who are their own provider. Here, the portfolio
only needs to exist so the Meta app can be attached to it in step 2. Do not add
your phone number to this portfolio. Customers' numbers, including your test
number, are connected through Embedded Signup, which creates their WABA under
their own portfolio. Pre-attaching the number to a WABA, or registering it on
the Cloud API, would make Meta treat it as an existing API number and push you
into migration instead of coexistence.

### 2. Meta app

Create the app by following
[How to Get WhatsApp API for Free](https://watobot.com/how-to/get-whatsapp-api-for-free.html)
(the app-creation steps; you don't need its access token section).

Then collect three values:

- **App ID** and **App Secret**: in the app, go to **App settings → Basic**.
  Put the App ID in `src/assets/app-config.ts` as `META_APP_ID` and the
  App Secret in `functions/.env` (step 3).
- **Embedded Signup Configuration ID**, created as follows. Configurations live
  under **Facebook Login for Business → Configurations**.

  1. Click **Create configuration**.

     ![Configurations screen with the Create configuration button](public/assets/10.create-configuration.png)

  2. **Name**: anything. **Login variation**: **WhatsApp Embedded Signup**.
  3. **Products**: check only **WhatsApp Cloud API**.

     ![Products step with only WhatsApp Cloud API checked](public/assets/11.choose-products.png)

  4. **Access token**: **System-user access token**, with expiration **Never**.
     Meta says Tech Providers should use business (system-user) tokens, which
     belong to the customer's business, not to the person who ran the popup,
     and don't depend on that person staying in the business. The token can't
     be changed after the Configuration is created.

     ![Access token step: choose System-user access token with expiration Never](public/assets/12.access-token-selection.png)

  5. **Assets**: **WhatsApp accounts**, with the task permission **MANAGE**.

     ![Assets step showing WhatsApp accounts as the only asset type](public/assets/13.assets.png)

  6. **Permissions**: `whatsapp_business_management` and
     `whatsapp_business_messaging`.

     ![Permissions step](public/assets/14.permissions.png)

  7. Save, and put the **Configuration ID** in `src/assets/app-config.ts` as
     `META_CONFIG_ID`.

### Permissions

Under **Other tools → Permissions and features**, the app only needs
`whatsapp_business_management` and `whatsapp_business_messaging`. Don't add
anything else. `business_management`, `email`, `manage_app_solution` and
`whatsapp_business_manage_events` aren't used. `public_profile` is granted
automatically.

![Permissions and features page](public/assets/8(2).permissions.png)

The app's own webhook, and the verifications Meta requires, come after the
backend is deployed (step 4).

### How customer tokens are handled

Meta requires a Tech Provider to protect, and not share, customers' access tokens, so
we hold each customer's token and never hand it out.

- Each account has a **Watobot API key**: 32 random bytes, generated in the
  browser and shown once, when the account first onboards a number. We store only a
  hash of it, on the user record. The browser doesn't keep it: the user types it
  whenever it is needed. Whenever a key is created or replaced, the user is signed
  out, so they have to type it to sign in again and see how much it matters.
- The key derives (HKDF-SHA256, with separate labels) both that hash and an
  AES-256-GCM key. The second one encrypts each number's Meta token, on
  `phoneNumbers/{phoneNumberId}`. The hash can't decrypt anything, and there is no server
  secret, so the stored data is unreadable without the customer's key.
- A request that carries the key (a send through the relay, setting the
  incoming URL, managing templates) lets the backend decrypt the token in memory,
  use it, and drop it.
- **Rotating** the key needs the old one. The `rotateKey` function re-encrypts every
  token under the new key in one batch, so the plaintext token is only ever in server
  memory, never in the browser. A **lost key can't be recovered**: resetting it (from the
  sign-in screen, the dashboard or the onboarding page) warns that the onboarded WABAs
  will be useless, deletes the stored tokens, and gives a new key. Each number must
  then be onboarded again.
- **Users manage their own account from the browser** (`src/assets/account.ts`):
  creating and resetting the key, and deleting the account. Functions are for what needs
  the Meta App Secret or a plaintext token: onboarding, key rotation, the relay, setting
  the incoming URL, templates, and the sign-in reset.

Data model. Functions create these records; a signed-in user can then read and manage
only their own, within the limits in `firestore.rules` (they can never change `userId`,
`usage` or `lastRelayCall`):

| Document | Fields |
|---|---|
| `users/{randomUserId}` | `phoneNumber`, `apiKeyHash`, `createdAt`, `rotatedAt` |
| `phoneIndex/{phone}` | `userId` |
| `phoneNumbers/{phoneNumberId}` | `userId`, `wabaId`, `phoneNumberId`, `displayPhoneNumber`, `encAccessToken`, `overrideUrl`, `activatedAt`, `lastRelayCall`, `usage`, `rateState`, `rateLimits` |

The Firebase sign-in `uid` is the random user ID, not the phone number.

### Rate limits

Template messages sent through the relay are rate limited per number, to protect the number
from being flagged. Free-form replies are not limited.

- **The values** are in [`functions/src/helpers/rateLimitConfig.ts`](functions/src/helpers/rateLimitConfig.ts):
  per window (minute, hour, day) a `floor` that is always allowed and a `growthPercent` over the
  previous window, plus statistical headroom. A send over any window's limit gets a `429` with
  `Retry-After`.
- **Per-number override:** set `rateLimits` on that number's `phoneNumbers/{id}` record (Admin SDK or
  the Firebase console; customers can't write it), with any part of the same shape, for example
  `{ "minute": { "floor": 40 } }`. Set `{ "enabled": false }` to switch limiting off for one number.
- **State** is `rateState` on the same record: per window the accepted count and the attempted
  count (refused requests included), for the current and the previous window. The limit is worked
  out from the *accepted* previous count only, so refused requests can't raise it. The number's page
  in the dashboard shows both, with the limits that apply. The limiter itself is
  [`rateLimiter.ts`](functions/src/helpers/rateLimiter.ts), shared by the Functions and the page.

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
commit it. `WEBHOOK_VERIFY_TOKEN` must also equal the `WEBHOOK_VERIFY_TOKEN` in
`src/assets/app-config.ts`, which the WABA page shows to people setting up the
test chatbot.

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

**Waitlist.** The dashboard (`/dashboard/` and its pages) is open to anyone, so Meta's reviewers can
sign in and test the app. The landing page's **Join Waitlist** button reveals the Google Group link,
and a count of people who clicked it is kept in `meta/waitlist`, incremented by the `joinWaitlist`
function once per browser. The nav button on the landing page still says **Join Waitlist**; point it
at `/dashboard/` (in `views/partials/header.html`) when you want the site itself to lead there.

### 4. Production deployment

**Frontend (GitHub Pages).** In the repo, go to **Settings → Pages → Source:
GitHub Actions**. Every push to `main` that touches `public/`, `views/`, `src/` or
`scripts/build-pages.js` runs `.github/workflows/deploy-pages.yml`, which type-checks,
builds the pages and scripts, and publishes `public/`. The generated HTML and JS are
not committed. Set a
custom domain in the same Pages settings if you want one. The site's links
assume it is served from the root of its domain.

**Backend (Firebase).**

1. Create a Firebase project and upgrade it to the Blaze plan (Functions need
   it to make outbound calls). Enable **Firestore**. Custom-token sign-in needs
   no provider toggle.
2. Point the repo at your project: set the project id in `.firebaserc`, and the
   web config and Functions URL in `src/assets/firebase-init.ts`.
3. Make sure `functions/.env` is filled in. `firebase deploy` packages the file
   as it sits on disk.
4. Deploy:

   ```bash
   firebase login
   firebase deploy --only firestore          # rules and indexes
   cd functions && npm run deploy            # builds, then deploys the Functions
   ```

**Let `verifyOtp` sign login tokens (once per project).** Login mints a Firebase
custom token, which the function must sign. In production it signs as its own
service account, and that account needs permission to do so. Without it, sign-in
fails with `Permission 'iam.serviceAccounts.signBlob' denied`. Find the account
the function runs as, then grant it the **Service Account Token Creator** role on
itself:

```bash
SA=$(gcloud run services describe verifyotp --region us-central1 \
  --project <project-id> --format="value(spec.template.spec.serviceAccountName)")

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$SA" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project <project-id>
```

This is the project's default compute service account
(`<project-number>-compute@developer.gserviceaccount.com`), and the role is
granted on that account only, not on the whole project. The IAM Service Account
Credentials API (`iamcredentials.googleapis.com`) must be enabled, which it
normally is. The change can take a minute or two to apply. It isn't needed
locally, where the Auth emulator doesn't check signatures.

**The app's webhook (after the deploy).** When `firebase deploy` finishes it
prints the URL of each function, including a line like
`Function URL (webhook(us-central1)): https://...`. That is your webhook URL.
Meta requires the app itself to have a webhook before a business's
incoming-URL override can be set. Without one, **Verify & save** on a WABA's
page fails with "your app must be subscribed to receive messages for WhatsApp
Business Account".

1. In the app dashboard, go to **Use cases → Customize → Step 2. Production
   setup → Configure Webhooks** and set:
   - **Callback URL**: the `webhook` function URL from the deploy output.
   - **Verify token**: the same value as `WEBHOOK_VERIFY_TOKEN` in
     `functions/.env` (and in `src/assets/app-config.ts`).

   Click **Verify and save**. Meta calls the function to check the token, so
   it must already be deployed.

   ![Configure Webhooks with the callback URL and verify token filled in](public/assets/8(1).dashboard-webhook-setup.png)

2. Under **Webhook fields**, subscribe to exactly these, and switch the rest
   off:

   | Field | Why |
   |---|---|
   | `messages` | Incoming messages and delivery statuses. |
   | `smb_message_echoes` | Messages typed in the Business app, so a bot doesn't reply on top of a human. |
   | `smb_app_state_sync` | Contact and state sync for coexistence. |
   | `history` | Chat history sync for coexistence. |
   | `message_template_status_update` | Tells a business when a template is approved or rejected. |

   ![Webhook fields list](public/assets/8(3).dashboard-webhook-fields.png)

   (That screenshot shows Meta's default selection, which is longer than the
   list above.)

### Testing and verification

Meta requires the following before the app can act as a Tech Provider.

**Review → Testing.** Meta wants an API call made with each permission your use
case lists. Do both from the page of the test number that came with your app. It
needs an incoming-message URL; if you don't have an app, use the
[test chatbot](test-chatbot/README.md) for one.

Embedded Signup isn't available yet, so store the test number's token yourself
with the seed script, the same way onboarding would:

1. In **Use cases → Customize → Production setup → Send message**, click
   **Generate token** and copy it. Find the test number's phone number ID there,
   and its WABA ID in Business Settings → Accounts → WhatsApp accounts.
2. Run the script from the repo root. It creates your account (if needed), makes a
   Watobot API key and prints it once, and stores the token encrypted under that
   key:

   ```bash
   META_ACCESS_TOKEN=<the token> node scripts/seed-test-waba.js \
     --phone <your WhatsApp number, digits only> \
     --phone-number-id <test phone number ID> --waba-id <test WABA ID>
   ```

   (Run `cd functions && npm run build` once first. It writes to production using
   your gcloud credentials, or to the emulator if `FIRESTORE_EMULATOR_HOST` is set.
   To add another number to an account that already has a key, pass
   `--api-key <that key>`.)
3. Run the app (step 3) and open `http://localhost:8765/dashboard/waba/?id=<test phone number ID>`
   after signing in.
4. **Override incoming message URL**: enter your Watobot API key (at the top) and your app's
   public HTTPS URL, then click **Verify & save**. This completes the test for
   `whatsapp_business_management`.
5. **Send a message**: copy the curl command on the page, put in your key and a
   recipient number, and run it in a terminal. This completes the test for
   `whatsapp_business_messaging`.

![A WABA page with the incoming-message URL saved](public/assets/24.waba-page.png)

Meta says the results can take up to 24 hours to appear, and each test stays
valid for 30 days. `public_profile` needs no specific count. When everything is
done, the page looks like this:

![Review → Testing page with the WhatsApp use case showing Testing complete](public/assets/23.app-testing-complete.png)

**Review → Verification.** Meta requires two verifications:

- **Business verification** of the portfolio the app is attached to. Complete
  it with the same name, address and phone number you entered when creating the
  portfolio, matched to the document you upload. See Meta's
  [Verify Your Business](https://www.facebook.com/business/help/2058515294227817)
  guide.
- **Access verification**, which confirms your business is a Tech Provider. See
  Meta's [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
  guide. Review typically takes around 5 business days. While it is pending,
  Embedded Signup fails with "App not active".

![Review → Verification page showing business verification as Verified and access verification as In review](public/assets/21.app-verification.png)

Embedded Signup does not work until the app has Advanced Access to
`whatsapp_business_management` and `whatsapp_business_messaging`, which comes
from App Review. Being an admin of the app does not get around it: the popup
fails with "Partner app lacks required advanced WhatsApp Business management
and messaging permissions for onboarding" (error `#2655111`). Until then you can
test everything except onboarding: the incoming-URL override and sending work
on any WABA you hold a token for, such as the test account that came with your
app (see "Review → Testing" above).
