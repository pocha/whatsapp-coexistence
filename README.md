# WhatsApp Coexistence

Lets a business run the WhatsApp Business App and the Cloud API on the same
number at once ("coexistence"). This repo has two parts:

- **Frontend** (this repo, `public/` generated from `views/`) — deployed as
  static files to **GitHub Pages**.
- **Backend** (`functions/`) — **Firebase Functions** + **Firestore**, with
  **Firebase Auth** (custom tokens, signed in via a WhatsApp OTP sent through
  [watobot](https://github.com/pocha/mudbot)) for accounts.

There's no self-hosted server anymore — the project used to run on a
Fastify process (`npm run dev`/`npm start`); that's been fully replaced.
"Self-hosting" this now means deploying your own copy to your own Firebase
project, the same way you'd deploy your own copy of the frontend to your own
GitHub Pages.

## Status

Built and tested:
- All four backend Functions (`checkEndpoint`, `completeOnboarding`,
  `relayMessage`, `webhook`) — see [Backend](#4-backend-functions--what-exists) below.
- Firestore security rules.
- Full test suite (`functions/npm test`) — unit tests + emulator-backed
  integration tests, all passing.
- Frontend wired to Firebase: phone number + WhatsApp OTP sign-in (Firebase
  Auth custom tokens), the WABA list + onboarding wizard on `/dashboard/`
  reading/writing Firestore directly and calling the real Functions, and the
  landing page's auth-aware Try Now / Go to Dashboard CTA.

Not yet done:
- **`public/assets/app-config.js` still has placeholder `META_APP_ID` /
  `META_CONFIG_ID`** — fill in real values before Embedded Signup will work.
- `public/dashboard/test.html` (the App-Review-recording buttons: send a
  message, create a template) is currently broken — its backend routes
  were dropped when the test API endpoints were deprioritized. Needed
  before actually submitting for Tech Provider approval (still required —
  see [Tech Provider status](#tech-provider-status-still-needed) below).
- Billing/metering UI (the Firestore usage counters exist and are written by
  `relayMessage`, and shown per-WABA in the wizard's Step 3; nothing charges
  against them yet).

## 1. Set up your Meta App

You need a Meta App with Tech Provider access before any of this works.

### Business Portfolio (do this first)

The app-creation flow will ask you to connect a Business Portfolio. Don't
pick your personal profile if it shows up as an option — Business
Verification (required for Tech Provider status) needs a real legal
business behind the portfolio, not an individual account.

You don't need a separate Facebook login for this. One Facebook account can
own multiple Business Portfolios, so if `business.facebook.com` drops you
into an unrelated existing portfolio (e.g. one made for a personal project),
stay logged in and create a **new** portfolio for this business instead —
use the portfolio switcher at the top-left of Meta Business Suite.

1. Go to [business.facebook.com](https://business.facebook.com/) and create
   a new Business Portfolio for this business (or click **"Create a
   business portfolio"** from the app-creation screen itself).
2. Fill in your **legal business name**, business email, and business
   address — use the details that match your registration documents, since
   these get checked during verification.
3. Check **Business Settings → Security Center → Business verification**.
   Meta only requires this once your usage needs it (e.g. requesting
   Advanced Access permissions, or crossing certain messaging-volume tiers)
   — it's common to see **"Your organisation does not need to be verified"**
   at this stage. That's fine; it's not a blocker. If it does say
   verification is needed, you'll be asked for documents such as a business
   registration certificate / tax ID, verified by document upload, a phone
   call, or a domain check, depending on your business.
4. Either way, you can create the Meta App and start local development now.
   If verification becomes required, Meta will prompt for it during **App
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
4. On the **Requirements** step you'll likely see **"No requirements
   identified."** That's expected, not an error — Development Mode with
   your own test assets doesn't need anything yet. The permission requests
   and any Business Verification requirement only get triggered later, when
   you submit for **App Review** to go live. Click Next.
5. Go to **App Settings → Basic** and note down the **App ID** and **App Secret**.
6. Add the **Facebook Login for Business** product to this app — needed for
   the Embedded Signup configuration you'll create next. (Account sign-in for
   this app's dashboard doesn't use Facebook at all — see
   [Firebase Auth](#firebase-auth-phone--whatsapp-otp) below.)

### Get your Embedded Signup Configuration ID

Meta's dashboard doesn't have a standalone "WhatsApp → Embedded Signup"
screen anymore — as of Embedded Signup v4, configurations live under
**Facebook Login for Business → Configurations**, and a config bundles
together the products, permissions, and asset access your signup flow
grants, rather than each being set separately.

1. **Facebook Login for Business → Configurations → Create configuration.**

   ![Configurations screen with the Create configuration button](public/assets/10.create-configuration.png)

2. **Name** — anything you like. **Login variation** — choose **WhatsApp
   Embedded Signup**.
3. **Products** — check only **WhatsApp Cloud API**. Leave Marketing
   Messages API, Click to WhatsApp/Direct/Messenger Ads, and Conversions
   API unchecked — none of those are used by this app.

   ![Products step with only WhatsApp Cloud API checked](public/assets/11.choose-products.png)

4. **Access token** — choose **User access token** (not System-user — that
   variant is for flows that authenticate via a business portfolio instead
   of an individual logging in, which isn't this). For **token expiration**,
   choose **Never**. The business is given this token to keep and use for
   sending messages (we never store it), so a 60-day expiry would break their
   integration every two months. See [Security notes](#security-notes).

   ![Access token step: User access token (the screenshot shows 60 days; choose Never)](public/assets/12.access-token-selection.png)

5. **Assets** — only **WhatsApp accounts** will be selectable (the rest are
   greyed out, since WhatsApp Cloud API was the only product chosen). Open
   **Select Asset Task Permissions** and choose **MANAGE** alone, rather
   than hand-picking the narrower items (MESSAGING, MANAGE_TEMPLATES,
   etc.). Reasoning: `completeOnboarding` calls `subscribed_apps` to
   activate coexistence, which is an account-configuration action that
   isn't obviously covered by any single narrow permission — MANAGE
   ("Manage all settings...") is the superset that includes it along with
   messaging and templates, and avoids a confusing failure at the very last
   step of onboarding if a narrower guess turns out to be missing exactly
   the one permission you needed.

   ![Assets step showing WhatsApp accounts as the only asset type](public/assets/13.assets.png)

6. **Permissions** — confirm both **`whatsapp_business_management`** and
   **`whatsapp_business_messaging`** are selected. These are usually
   auto-selected once WhatsApp Cloud API was chosen as the product.

   ![Permissions step with both whatsapp_business_management and whatsapp_business_messaging selected](public/assets/14.permissions.png)

7. Finish and save. Copy the **Configuration ID** it gives you into
   `public/assets/app-config.js`'s `META_CONFIG_ID`.

### Tech Provider status (still needed)

Running Embedded Signup / Coexistence at all requires **this app** to be an
approved Meta Tech Provider — that's a requirement on the app itself,
separate from whether individual end-users need App Review for their own
WhatsApp usage (they don't, if they're only using the API for their own
number — see `views/pages/how-to/whatsapp-api-access.html`). Tech Provider
approval needs two demo videos (a message sent from the app, a template
created by the app) at submission time — see the Status section above for
why that's currently blocked on rebuilding the test UI against Functions.

## 2. Set up Firebase

1. Create a Firebase project (Firestore + Functions + Authentication).
   Region used here: `asia-south1`.
2. **Firestore** → create the database in the region above. Rules and
   indexes are checked into this repo (`firestore.rules`,
   `firestore.indexes.json`) — deploy them with:
   ```bash
   firebase deploy --only firestore
   ```
3. **Authentication** — no sign-in provider to enable here. Login mints a
   Firebase **custom token** server-side (see
   [Firebase Auth](#firebase-auth-phone--whatsapp-otp) below), which works
   out of the box on any Firebase project — custom tokens aren't a toggleable
   provider like Facebook/Google are.
4. A service account key is **not required**: the emulators don't need real
   credentials (local login uses the Auth emulator, which issues unsigned
   custom tokens), and deployed Functions get credentials automatically
   from their runtime. If you download one anyway for local admin scripts
   (**Project Settings → Service Accounts → Generate new private key**),
   keep it out of the repo — `.gitignore` covers common key filename
   patterns, but double check before committing.
5. `.firebaserc` in this repo already points at project id `wa-coexistence`
   — change it if you're using your own project.

## 3. Backend (Functions)

```bash
cd functions
npm install
```

### Config & secrets

One file — `functions/.env`, gitignored, loaded via plain `dotenv` (not
Firebase's params/Secret Manager system, kept intentionally simple):

```bash
cp .env.example .env
```
```
META_APP_ID=<your App ID>
META_APP_SECRET=<your App Secret>
WEBHOOK_VERIFY_TOKEN=<any string you make up>
WATOBOT_API_KEY=<your watobot.xyz API key>
```

`WATOBOT_API_KEY` is used only by `sendOtp` to text the login code over
WhatsApp via [watobot](https://github.com/pocha/mudbot) — get one from your
watobot account.

Used identically by the emulator *and* a real deployment — `firebase
deploy` packages whatever's actually on disk in `functions/` (it isn't
git-aware), so the same `.env` that powers local dev also ships with the
deployed function. Trade-off worth knowing: this means secrets sit in a
plain-text file rather than Secret Manager's encrypted store. Acceptable
here since the file never leaves your machine/CI (gitignored) and only
whoever can already deploy could read it — revisit if that stops being true
for your setup.

`WEBHOOK_VERIFY_TOKEN` doesn't need to match anything Meta-issued — it's a
value *you* pick, used in two places: the `checkEndpoint` verification
handshake against a business's own URL, and the `verify_token` Meta stores
when subscribing.

### Running locally

From the **repo root** (not `functions/`):
```bash
npm start
```
Builds the frontend, serves it at `http://localhost:8765/dashboard/`,
watches `views/` and rebuilds on change, and starts the Functions +
Firestore emulators — all in one command, `Ctrl+C` stops everything.

Or just the backend, from `functions/`:
```bash
npm run serve   # builds, then starts the Functions + Firestore emulators
```

**Auth and Firestore are both emulated locally** (`--only
functions,firestore,auth`), so local dev never touches real production data
or needs a service account key — the Auth emulator issues unsigned custom
tokens, which is what `verifyOtp`'s `createCustomToken` needs. Local logins
are emulator-only users and don't exist in your real Firebase project.

Also note: **`sendOtp` sends a real WhatsApp message via watobot** even in
local dev — there's no stub for it outside the test suite (which overrides
`WATOBOT_API_BASE` the same way tests override `GRAPH_API_BASE`), so signing
in locally texts your own phone for real.

Emulator UI: `http://127.0.0.1:4000`. Note that **Embedded Signup itself
talks directly to Facebook's real servers from the browser** — there's no
way to stub that part either, so exercising the actual onboarding flow (not
just looking at the UI) requires real values in `.env` *and* in
`public/assets/app-config.js` (see [Frontend](#5-frontend)).

### Testing

```bash
npm test              # unit tests, then emulator-backed integration tests
npm run test:unit         # fast, no emulator, mocked fetch
npm run test:integration  # spins up real Firestore/Auth/Functions emulators
```

See [functions/src](functions/src) for what's covered — briefly: `graphApi.ts`
and the relay's date-key helpers are unit-tested with mocked `fetch`;
Firestore rules and full HTTP round-trips (via a local Meta API stub,
`functions/test/meta-stub.js`) are covered by the integration suite.

### Deploying

```bash
npm run deploy   # builds, then firebase deploy --only functions
```

## 4. Backend (Functions) — what exists

Only four Functions — the goal was to keep the trusted/server-side surface
as small as possible. Everything else (reading/writing a business's own
data) happens as **direct Firestore client calls from the frontend**,
gated by `firestore.rules`, once that wiring is done (see
[Status](#status)).

| Function | What it does |
|---|---|
| `checkEndpoint` | Hits a business-supplied URL with Meta's own webhook verification handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`), before that URL is ever used as an `override_callback_uri`. Requires sign-in (it fetches an arbitrary caller-supplied URL — an anonymous version of that is an SSRF target). |
| `completeOnboarding` | Exchanges the Embedded Signup `code` for an access token and calls `subscribed_apps` with the (already-verified) override URL. Needs the Meta App Secret, so it has to be server-side. Doesn't touch Firestore — a successful call already proves the signed-in user administers that WABA, so the client writes the resulting `wabas/{phoneNumberId}` doc itself. |
| `relayMessage` | `POST /:phoneNumberId/messages` — a stateless proxy in front of Meta's own `/{phone-number-id}/messages`. The caller supplies their **own** WhatsApp access token per-request; nothing is stored. This is the one place the backend sits in the message path, specifically so rate limiting / per-recipient serialization (**upcoming**, not yet built) can be added here later. Also the only Function that writes to Firestore as Admin — `lastRelayCall` and the `usage.{daily,weekly,monthly}` counters — because that's billing-relevant data a client must not be able to edit directly. |
| `webhook` | Meta's required app-level webhook (GET verify handshake, POST ack). Fallback only — every real WABA sets its own override via `completeOnboarding`, so this rarely sees traffic. |

Templates aren't something the backend manages: they're created directly
against Meta's `/{waba-id}/message_templates` (with the business's own
token) and referenced by name/language in the relay body, same as Meta's
own API.

### Firestore data model

One document per onboarded number:

```
wabas/{phoneNumberId}: {
  ownerUid,            // Firebase Auth uid — the normalized login phone number
  wabaId,
  overrideUrl,
  activatedAt,
  lastRelayCall: { at, ok, statusCode },   // Function-written only
  usage: {                                  // Function-written only
    daily:   { "2026-09-29": 12, ... },
    weekly:  { "2026-W40": 40, ... },
    monthly: { "2026-09": 120, ... },
  },
}
```

`phoneNumberId` (not `wabaId`) is the document ID on purpose — it's what
the relay and Meta both key sends off operationally, and it means billing
attribution needs no separate API key: Meta itself only lets a token
successfully send through a `phoneNumberId` it's actually authorized for,
so a successful relay call already proves the caller controls that number.

**Trust boundary** (`firestore.rules`): the owner can read and write their
own document, *except* `lastRelayCall` and `usage` — those are written only
by `relayMessage` via the Admin SDK (which bypasses rules entirely), since
they're the basis for billing and must not be client-editable. Everything
else (`overrideUrl`, `activatedAt`, etc.) is written directly by the
frontend right after a successful `completeOnboarding` call — no Function
needed for that, since the client is already proven to be the legitimate
owner by that point.

### Firebase Auth (phone + WhatsApp OTP)

Account identity is the business's own **WhatsApp number**, not a Facebook
account — a **separate** login from Embedded Signup's own `FB.login()`
popup, not a reuse of it. (An earlier version of this app tried reusing
Facebook Login for account sign-in; that didn't work out — Embedded Signup's
login call only ever returns a one-time exchange `code` with no reusable
`accessToken`, and the more general "Facebook Login for Business" product
doesn't accept the scope strings Firebase Auth's own Facebook provider
sends. Phone + OTP sidesteps both problems, and is arguably a better fit
anyway — it identifies the number being coexistence-enabled, not an
unrelated Facebook identity.)

The flow (`sendOtp` / `verifyOtp` Functions):
1. `sendOtp` takes a phone number, generates a 6-digit code, stores it in
   Firestore (`otps/{phone}`, Admin-SDK-only — not reachable by client rules)
   with a 5-minute expiry, and texts it to that number over WhatsApp via
   [watobot](https://github.com/pocha/mudbot). Rate-limited to one send per
   phone per 60 seconds.
2. `verifyOtp` checks the code (max 5 attempts before it's invalidated),
   deletes the OTP doc, and mints a Firebase **custom token** via
   `admin.auth().createCustomToken(phone)` — the normalized phone number
   *is* the Firebase `uid`, no separate mapping table.
3. The frontend calls `signInWithCustomToken()` with that token to finish
   sign-in.

No separate signup flow, no password, no app-issued API keys — that
Firebase ID token is the only account credential, and the business's own
WhatsApp access token (never stored) is the only credential the relay
needs.

## 5. Frontend

`public/` is served as-is by GitHub Pages, generated from `views/`:

| Path | Purpose |
|---|---|
| `/` | Landing page — features, pricing, "Why Coexistence?", how-to guides, contact |
| `/dashboard/` | Sign in, see your onboarded WABAs, delete account |
| `/dashboard/waba.html?id=<phoneNumberId>` | The onboarding wizard for one WABA (new or resumed) |
| `/dashboard/test.html` | App-Review recording buttons (**currently broken** — see Status) |
| `/privacy.html`, `/tos.html`, `/data-deletion.html` | Legal pages |
| `/how-to/*.html` | Business Portfolio / Meta App / WhatsApp API access guides |

### Editing the marketing pages (build step)

Pages aren't hand-written HTML — they're generated from templates so the
header/footer/nav stay in one place:

- `views/pages/*.html` — page content (`views/pages/how-to/*.html` for the guides)
- `views/partials/head.html`, `header.html`, `footer.html` — shared chrome, pulled in with `<!--#include partial="name"-->`
- `scripts/build-pages.js` — expands the templates into `public/`

```bash
npm run build:pages
```

No templating engine, no dependency — same include/variable-substitution
approach as [watobot](https://github.com/pocha/mudbot/blob/main/scripts/build-pages.js).
Styling also matches watobot: `views/partials/head.html` pulls Tailwind's
CDN build plus watobot's `theme.css`/`theme.js` straight from GitHub (via
jsDelivr) rather than vendoring a copy here.

The generated `public/*.html` files aren't committed — they're build
output, regenerated every time (see `.gitignore`). `public/assets/` and
`public/dashboard/{app,test}.js` are hand-authored and stay tracked as
normal.

`.github/workflows/deploy-pages.yml` runs `npm run build:pages` and deploys
`public/` to GitHub Pages on every push to `main`. One-time setup:
**Settings → Pages → Source: GitHub Actions**.

## Security notes

- The WABA access token issued during Embedded Signup **never expires**
  when the Configuration's token expiration is set to Never (see step 4 of
  [Get your Embedded Signup Configuration ID](#get-your-embedded-signup-configuration-id)),
  until revoked in Business Manager. Nothing in this codebase persists it —
  `completeOnboarding` uses it once, in memory, for the length of one
  request; `relayMessage` forwards the caller's own token per-request and
  never logs or stores it.
- Firestore rules explicitly block clients from writing `lastRelayCall` or
  `usage` on their own documents — see [Firestore data model](#firestore-data-model).
- The service account key (if you download one) is gitignored by filename
  pattern in this repo — double-check `git status` before committing if you
  ever generate a new one with a different name.
- Always HTTPS in production — Meta requires it for the OAuth redirect and
  webhook regardless.
