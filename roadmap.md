# Roadmap

What an ideal Tech Provider needs, from the research behind the how-to guides on the site
(`views/pages/how-to/`). Tick items as they ship, and correct an entry if Meta's docs say
otherwise. The app is still waitlist-only, so the guides may describe things not built yet.
Last reviewed 2026-10-17. The functions that exist are listed in the README's API section.

### Built
- [x] Phone + WhatsApp OTP sign-in, per-account Watobot API key, key rotation
- [x] Meta token stored encrypted under the user's Watobot API key (decrypted in memory per request)
- [x] Message relay, incoming-URL override (`PUT /numbers/<id>/webhook`), template manager (list, create, edit, delete)
- [x] `POST /numbers/<id>/register` (used by the wizard's register step)
- [x] Rate limiting for template sends (ramp-up, attempts vs accepted, per-number override) and usage counters
- [x] Embedded Signup launched with `featureType: whatsapp_business_app_onboarding`
- [x] App-level webhook fields subscribed (checked through the Meta MCP, 2026-10-16): `account_alerts`, `account_review_update`, `account_update`, `message_template_quality_update`, `message_template_status_update`, `messages`, `phone_number_name_update`, `phone_number_quality_update`, `security`, `history`, `smb_message_echoes`, `smb_app_state_sync`

### P0: the migration promise and launch
- [x] **Security: ownership is checked at sign-up.** `exchangeCode` no longer trusts the IDs the browser sends: Meta's `debug_token` must list the WABA among those the token was granted, and the WABA's phone number list must hold the number (if that list can't be read, the token must at least be able to read the number, and the fallback is logged as `ownership check fell back`). A number that belongs to another Watobot account is never replaced (409). Not yet run against real Meta: the `debug_token` call authorised with the app token, and `GET /<WABA>/phone_numbers`.
Design: onboarding is a guided, resumable flow that starts only once the user has what they need afterwards.

**The flow**
A step-by-step wizard: `checks → Meta onboarding → callback override → (coexistence: sync) or (standard: register) → template migration → done`

1. [x] **Gate before the popup.** The button reads "Start onboarding". Collect the callback URL and verify it (the challenge check exists). The user confirms their endpoint parses and stores history, contacts and echoed messages, and that the number is active on the WhatsApp Business app (2.24.17 or higher). Meta can't be asked about an arbitrary number before onboarding (`is_on_biz_app` needs a phone number ID and a token), so we don't ask for the number. The URL is held in the page, not in localStorage, and sent with the signup code. **Templates readiness** is also checked here, before the user disconnects from the previous provider, so a surprise doesn't cost them downtime: (a) no previous provider, so skip; (b) I can see my previous provider's Messaging account in my own Business Settings, so paste its ID (numeric; 15 to 16 digits seen, no known check digit) and add Watobot as a partner on it now; (c) it belongs to my provider, so get the template list from them now (we show the one read call they can run) and paste the JSON, which we parse and count. Access can't be proven before onboarding (no token yet), so this is a confirmation plus a format check, and we verify access after the popup.
2. [x] **Send test data.** One button sends one webhook of each type (message, echo, contacts, history), each carrying a fresh random code. The user enters the four codes and we say which are wrong. At most one send per 30 seconds, enforced on the server. The codes of the last send are kept in `testRuns/{userId}`, which has no Firestore rules, so no browser can read it, and are only checked on the server. Only HTTPS, and private and internal addresses are blocked. Test events are marked with `X-Watobot-Test: true` and are not signed. The same panel is on the number page. The test chatbot prints every event with any test code.
3. [x] **Subscribe and set the override inside onboarding** (today `setWebhook` runs later).
4. [x] **Branch on the signup event.** `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` = coexistence. `FINISH` = the customer took the new-number path. Then check `is_on_biz_app` and `platform_type`.
5. [x] **Number not on the Business app:** offer (a) continue as API only (check status, then register with a PIN the user enters, show Meta's error with a Retry; mind the 10-in-72-hours limit), or (b) a link to de-register or disconnect from the previous provider, then come back and retry. Make `registerNumber` refuse when `is_on_biz_app` is true. Never store the PIN.
6. [x] **Sync screen (coexistence only):** a blocking screen after the popup. One button starts contacts, then history (`POST /<PHONE_NUMBER_ID>/smb_app_data`, `sync_type` `smb_app_state_sync`, then `history`), with a status for each. Each sync can be requested only once, so offer a retry only when the request itself failed, and block double clicks. The user then clicks Finished. The screen survives a refresh and returns on every sign-in until done, with the 24-hour countdown. Watobot stores state only, never the data, and can't see progress because those webhooks go to the customer.
7. [x] **Template step, after the sync (not blocking it):** see "Templates" below.
8. [x] **Persisted onboarding state, once there is a phone number ID.** Until then nothing is stored, and any failure means starting from scratch. After that, `phoneNumbers/{id}` holds the step, the signup event, `isOnBizApp`, `platformType`, the last error, and each sync's state, time and error (written by the functions, never the browser). An unfinished onboarding appears in the left menu, with a Continue button that resumes at the right step. Which step a number needs is worked out from its record on every load (`effectiveStep`): no callback URL saved means the override step; an API-only number that Meta no longer shows as connected means register; a coexistence number whose two syncs aren't both requested means sync; otherwise the stored step (templates, or the not-on-the-app choice) or done. The number page, the sidebar and the wizard all use it. Once the token is stored, later steps don't need the popup again; the signup code is single-use and short-lived, so only the exchange needs a repeat.
9. [x] **Number page:** the number is the title, with an API only / Coexistence chip; the IDs sit under it (phone number ID, Messaging account ID, previously the WABA ID); for a coexistence number, when the contacts and history syncs were requested.
10. [x] **Help for Meta's signup errors** next to the button (they appear inside Meta's popup): 2655093, 3441049, 2655094, 3441030, 3441045, 2655095 / 2655048, and "registered to an existing WhatsApp account". Map the signup's cancel or error event to the same text if it carries an error (not verified; needs Meta's Implementation page).
11. [ ] **`account_update` handling** in the `webhook` function (it returns 200 and drops everything): `PARTNER_REMOVED` (clean up, notify), `ACCOUNT_OFFBOARDED` (pause sends), `ACCOUNT_RECONNECTED` (resume). Account-level and template webhooks are never overridden, so they always reach Watobot.
12. [x] **Webhook checks Meta's signature.** `/webhook` refuses anything not signed with the app secret (`X-Hub-Signature-256`) and acknowledges the rest. Template and number quality and status updates are not kept or shown: Meta emails the Business Suite admins about template decisions, enforcement and partner removal (not confirmed: quality-score and number-quality changes).

**Templates (P0)**
- [x] Settled at the gate (see item 1): no previous provider, a Messaging account the user owns (its ID), or a template list from the provider (pasted JSON).
- [x] After onboarding, list the templates in the account the signup returned (`waba_id`, the Messaging account). For coexistence this is the existing account. If there are templates, show the count and move on.
- [x] **User owns the old account:** first check that we can read it with our token (a failed read means the partner share hasn't worked, so fall back to the provider route). Then call `POST /<DEST_WABA_ID>/migrate_message_templates` with `source_waba_id`, show "N templates migrated" and `failed_templates` with Meta's reasons (retry the failures), and link to their Messaging account to check.
- [x] **Provider owns the old account:** Meta only migrates within one Meta business, so asking the provider to run it with our account ID won't work. Create the pasted templates one by one in the new account (paced: Meta allows 100 creations per hour per account), and report which succeeded.
- [ ] Show each template's status afterwards (Meta doesn't say whether migrated copies are reviewed again).
- [x] The wizard keeps the source account ID on the number's document once it exists; before that it lives only in the page. Watobot's business portfolio ID for the partner share is `1821963108976783`.
- [x] Fallback: create templates in the template manager, or skip for now.

- [x] **The API is grouped by resource,** with the key as the bearer token: `/numbers/<id>/...`, `/templates/<id>/...`, `/templatesBulk/<id>/...` (the 300 s one), `/onboarding/...`. The old one-function-per-call names are gone.
- [x] **Sending status and notifications:** what decides whether a send goes out is a list of reasons per number, each with its cause, and a status (`ok`, `limited`, `blocked`, `disabled`) worked out from them. It is set from Meta's webhooks as they arrive (ban or disable, restriction with its end, account review, disconnection, display name decision, messaging limit tier, template paused or disabled) and from a refresh (`GET /numbers/<id>?refresh=true`, at most once in ten minutes, which replaces what notifications set and notes any disagreement). The relay refuses every send for a disabled number, template sends for a blocked one, caps a limited one at five a day, keeps the daily limit under Meta's tier, refuses a paused or disabled template by name, and pauses template sends for an hour after Meta's spam-rate-limit refusal. Shown as chips beside the number, each opening a popup with the refresh and the display name form, and below as the number's Notifications (kept a month by a Firestore TTL policy). Not built: the payment method has no notification, so only a refresh or a refused send learns of it; a template's quality is shown as a notification only.
- [x] **Display name requests** (`PUT /numbers/<id>/display-name`): one change at a time, refused while one is in review.

### P1: moving in and out
- [x] Disconnect / leave Watobot: Delete account first disconnects each number from Meta (`POST /numbers/<id>/disconnect`: unsubscribe our app, and de-register an API-only number unless the user unticks it; a coexistence number is only unsubscribed, and the user is told to disconnect it in the Business app), then deletes the records. Needs the API key; "I've lost my key" skips the Meta calls.
- [x] Deregister endpoint, standard numbers only (`POST /numbers/<id>/deregister`; Meta's deregister can't be used on a number that is on both the app and the API)
- [ ] Ownership on the number page: show whether the number's Messaging account belongs to the user's own portfolio or to a previous provider (the template migration depends on it)
- [x] **Rate-limit read API and headers:** `GET /numbers/<id>/limits`, and `X-RateLimit-Remaining-*` / `X-RateLimit-Reset-*` headers on template sends, so a client (or an AI tool) can pace itself.

### P2: reliability and trust
- [x] **MCP server**, hosted and local, one set of tools (`functions/src/mcp/tools.ts`): the `mcp` Function (`Authorization: Bearer <key>` or `/mcp/<key>`, for claude.ai, ChatGPT and any tool that takes an address) and the `watobot-mcp` package (`mcp/`, over stdio, for tools that launch a program). The API key is the credential, so there is no OAuth. Also built: key-only access to the wizard checks, `listNumbers` / `getNumber` (the dashboard reads through them as well, so the two cannot drift apart), and a link that opens the wizard at Meta's sign-up (`?checks=done&callback=`) and hands back to the AI tool afterwards. Still to do: exclude the `mcp` requests from Cloud Logging (see the README), publish to npm, check claude.ai and ChatGPT connect with the address (their auth options change), an OpenAPI description and `llms.txt`, and OAuth only if a connector directory asks for it.
- [ ] Close the browser's read on `phoneNumbers` in the rules: blocked only by the key reset and delete account code in `src/assets/account.ts`, which still query the numbers directly
- [ ] Move the last direct browser writes (first key, key reset, the Firestore side of delete account) into functions, so the rules can be read-only
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
- Onboarding with no callback URL (`noCallback`) subscribes the app with no `override_callback_uri`. Not yet checked against Meta: that incoming events then reach the app's own webhook, and whether subscribing without an override removes an override set earlier
- Whether migrated templates are reviewed again (Meta says only that migration "recreates" them; review "can take up to 24 hours")
- What happens to templates on a second coexistence onboarding, and which Messaging account a standard-to-coexistence move ends up in
- Whether unsharing a coexistence partner in Business Settings disconnects it (Meta documents only the Business app disconnect)
- Whether several numbers can share one display name
- A Messaging account is shareable with "up to two partners" on one Meta page and "only one" on another
