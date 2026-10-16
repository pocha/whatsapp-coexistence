# WhatsApp Coexistence

Lets a business run the WhatsApp Business app and the WhatsApp API on the same
number at once ("coexistence"). The frontend is static and deployed to GitHub Pages: pages are
generated from `views/` and the browser scripts are TypeScript in `src/`, both built
into `public/` (`npm run build:pages`; `npm run typecheck` checks the types). The backend (`functions/`) is
Firebase Functions, Firestore and Firebase Auth.

## Roadmap

What an ideal Tech Provider needs, from the research behind the how-to guides on the site
(`views/pages/how-to/`). Tick items as they ship, and correct an entry if Meta's docs say
otherwise. The app is still waitlist-only, so the guides may describe things not built yet.
Last reviewed 2026-10-16.

### Built
- [x] Phone + WhatsApp OTP sign-in, per-account Watobot API key, key rotation
- [x] Meta token stored encrypted under the user's Watobot API key (decrypted in memory per request)
- [x] Message relay, incoming-URL override (`setWebhook`), template manager (list, create, edit, delete)
- [x] `registerNumber` (manual, from the number page)
- [x] Rate limiting for template sends (ramp-up, attempts vs accepted, per-number override) and usage counters
- [x] Embedded Signup launched with `featureType: whatsapp_business_app_onboarding`
- [x] App-level webhook fields subscribed (checked through the Meta MCP, 2026-10-16): `account_alerts`, `account_review_update`, `account_update`, `message_template_quality_update`, `message_template_status_update`, `messages`, `phone_number_name_update`, `phone_number_quality_update`, `security`, `history`, `smb_message_echoes`, `smb_app_state_sync`

### P0: the migration promise and launch
Design: onboarding is a guided, resumable flow that starts only once the user has what they need afterwards.

**The flow**
A step-by-step wizard: `checks → Meta onboarding → callback override → (coexistence: sync) or (standard: register) → template migration → done`

1. [ ] **Gate before the popup.** The button reads "Start onboarding". Collect the callback URL and verify it (the challenge check exists). The user confirms their endpoint parses and stores history, contacts and echoed messages, and that the number is active on the WhatsApp Business app (2.24.17 or higher). Meta can't be asked about an arbitrary number before onboarding (`is_on_biz_app` needs a phone number ID and a token), so we don't ask for the number. The URL is held in the page, not in localStorage, and sent with the signup code. **Templates readiness** is also checked here, before the user disconnects from the previous provider, so a surprise doesn't cost them downtime: (a) no previous provider, so skip; (b) I can see my previous provider's Messaging account in my own Business Settings, so paste its ID (numeric; 15 to 16 digits seen, no known check digit) and add Watobot as a partner on it now; (c) it belongs to my provider, so get the template list from them now (we show the one read call they can run) and paste the JSON, which we parse and count. Access can't be proven before onboarding (no token yet), so this is a confirmation plus a format check, and we verify access after the popup.
2. [ ] **Send test data.** One button sends one webhook of each type (message, echo, contacts, history), each carrying a random code. The user enters the four codes and we say which are wrong. At most one send per 30 seconds, enforced on the server. Codes are derived from a keyed hash of the user, the event type and the send time, so nothing is stored; a new send invalidates the old codes. Only HTTPS, and block private and internal addresses. Test events are marked with `X-Watobot-Test: true` and are not signed. The same panel goes on the number page. The test chatbot already logs every POST body.
3. [ ] **Subscribe and set the override inside onboarding** (today `setWebhook` runs later).
4. [ ] **Branch on the signup event.** `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` = coexistence. `FINISH` = the customer took the new-number path. Then check `is_on_biz_app` and `platform_type`.
5. [ ] **Number not on the Business app:** offer (a) continue as API only (check status, then register with a PIN the user enters, show Meta's error with a Retry; mind the 10-in-72-hours limit), or (b) a link to de-register or disconnect from the previous provider, then come back and retry. Make `registerNumber` refuse when `is_on_biz_app` is true. Never store the PIN.
6. [ ] **Sync screen (coexistence only):** a blocking screen after the popup. One button starts contacts, then history (`POST /<PHONE_NUMBER_ID>/smb_app_data`, `sync_type` `smb_app_state_sync`, then `history`), with a status for each. Each sync can be requested only once, so offer a retry only when the request itself failed, and block double clicks. The user then clicks Finished. The screen survives a refresh and returns on every sign-in until done, with the 24-hour countdown. Watobot stores state only, never the data, and can't see progress because those webhooks go to the customer.
7. [ ] **Template step, after the sync (not blocking it):** see "Templates" below.
8. [ ] **Persisted onboarding state, once there is a phone number ID.** Until then nothing is stored, and any failure means starting from scratch. After that, `phoneNumbers/{id}` holds the step, the signup event, `isOnBizApp`, `platformType`, the last error, and each sync's state, time and error (written by the functions, never the browser). An unfinished onboarding appears in the left menu, with a Continue button that resumes at the right step. Once the token is stored, later steps don't need the popup again; the signup code is single-use and short-lived, so only the exchange needs a repeat.
9. [ ] **Number page:** the number's state at the top, and for coexistence numbers when the contacts and history syncs were last requested. A standard number shows a persistent "no Business app on this number" note.
10. [ ] **Help for Meta's signup errors** next to the button (they appear inside Meta's popup): 2655093, 3441049, 2655094, 3441030, 3441045, 2655095 / 2655048, and "registered to an existing WhatsApp account". Map the signup's cancel or error event to the same text if it carries an error (not verified; needs Meta's Implementation page).
11. [ ] **`account_update` handling** in the `webhook` function (it returns 200 and drops everything): `PARTNER_REMOVED` (clean up, notify), `ACCOUNT_OFFBOARDED` (pause sends), `ACCOUNT_RECONNECTED` (resume). Account-level and template webhooks are never overridden, so they always reach Watobot.
12. [ ] **Number status endpoint** (key-authenticated; `GET /<PHONE_NUMBER_ID>?fields=status,code_verification_status,is_on_biz_app,platform_type`) and a command on the number page.

**Templates (P0)**
- [ ] Settled at the gate (see item 1): no previous provider, a Messaging account the user owns (its ID), or a template list from the provider (pasted JSON).
- [ ] After onboarding, list the templates in the account the signup returned (`waba_id`, the Messaging account). For coexistence this is the existing account. If there are templates, show the count and move on.
- [ ] **User owns the old account:** first check that we can read it with our token (a failed read means the partner share hasn't worked, so fall back to the provider route). Then call `POST /<DEST_WABA_ID>/migrate_message_templates` with `source_waba_id`, show "N templates migrated" and `failed_templates` with Meta's reasons (retry the failures), and link to their Messaging account to check.
- [ ] **Provider owns the old account:** Meta only migrates within one Meta business, so asking the provider to run it with our account ID won't work. Create the pasted templates one by one in the new account (paced: Meta allows 100 creations per hour per account), and report which succeeded.
- [ ] Show each template's status afterwards (Meta doesn't say whether migrated copies are reviewed again).
- [ ] The wizard keeps the source account ID on the number's document once it exists; before that it lives only in the page. Watobot's business portfolio ID for the partner share is `1821963108976783`.
- [ ] Fallback: create templates in the template manager, or skip for now.

### P1: moving in and out
- [ ] Disconnect / leave Watobot: unsubscribe the app from the account, delete the stored token, remove the record (today "Delete account" makes no Meta calls)
- [ ] Deregister endpoint, standard numbers only (Meta's deregister can't be used on a number that is on both the app and the API)
- [ ] Ownership check on the number page: is the Messaging account in the user's portfolio
- [ ] Template status and quality in the manager, and alerts on `message_template_status_update` / `message_template_quality_update`
- [ ] Number quality alerts (`phone_number_quality_update`), optional throttling on quality drops

### P2: reliability and trust
- [ ] Per-recipient ordering, retries when the customer's endpoint is down, de-duplication, published latency figures
- [ ] `messaging_account_id` in send calls (required in multi-Messaging-account setups from Phase 2)
- [ ] Data export and deletion with Meta-side cleanup; say plainly what is stored (the server decrypts the token per request, so don't call it "zero knowledge")
- [ ] Status page, uptime and error alerting, support channel, documented migration-help SLA
- [ ] App goes live: it is in `dev_mode`, contact email unverified, no support URL or description yet
- [ ] A "Move to Watobot" wizard and a "Move out" kit

### Meta behaviours we rely on
| Behaviour | Source (Meta for Developers) | As of |
| --- | --- | --- |
| Coexistence does not create a partner-specific Messaging account; the existing account is converted and keeps its ID | Embedded Signup > Onboard WhatsApp Business app users, and Account model evolution > Onboarding | 2026-06-26 |
| 24 hours after onboarding to start the contacts and history syncs; each only once | Onboard WhatsApp Business app users | 2026-06-26 |
| Overrides apply to `messages`, `message_echoes`, `smb_message_echoes`, `smb_app_state_sync`, `history` and more; template and account-level webhooks (`account_update`, `account_review_update`, `account_alerts`) always go to the app's own URL | Webhooks > Override the callback URL | 2026-09-28 |
| The Deregister API can't be used on a number in use with both Cloud API and the Business app; disconnect in the app instead | Onboard WhatsApp Business app users; Graph API reference for deregister | 2026-06-26 |
| A number can only be registered through the API (not WhatsApp Manager or the App Dashboard) | Business phone numbers > Register a phone number | 2026-06-26 |
| The two-step PIN is being deprecated for eligible numbers; keep sending a six-digit `pin` on register for now | Account model evolution (Updates to WhatsApp Business accounts) | 2026-09-22 |
| Template migration: same Meta business, `APPROVED` with `GREEN` or `UNKNOWN` quality; it recreates the templates | Templates > Migration | 2026-06-24 |
| New account model GA 2026-09-23; Phase 2 (H1 2027) adds `waac_id` to message events; Phase 3 (H1 2028) requires WAAC IDs in API paths | Account model evolution | 2026-09-22 |

### Open questions
- Whether migrated templates are reviewed again (Meta says only that migration "recreates" them; review "can take up to 24 hours")
- What happens to templates on a second coexistence onboarding, and which Messaging account a standard-to-coexistence move ends up in
- Whether unsharing a coexistence partner in Business Settings disconnects it (Meta documents only the Business app disconnect)
- Whether several numbers can share one display name
- A Messaging account is shareable with "up to two partners" on one Meta page and "only one" on another

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
