// Types shared by the Functions and the browser code (src/ at the repo root imports this
// file with `import type`, which is erased at build time). They describe the Firestore
// records and the request bodies of the Functions the browser calls, so a renamed field
// fails to compile on both sides instead of breaking at runtime.

export interface EncryptedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** users/{userId} */
export interface UserDoc {
  phoneNumber: string;
  apiKeyHash?: string;
  createdAt: number;
  rotatedAt?: number;
}

import type { RateLimitOverride, RateState } from './rateLimiter';

/** Counters written by the relay, keyed by day (YYYY-MM-DD), ISO week (YYYY-Www) and month (YYYY-MM). */
export interface Usage {
  daily?: Record<string, number>;
  weekly?: Record<string, number>;
  monthly?: Record<string, number>;
}

/**
 * Where a number is in the onboarding wizard. Only numbers with a phone number ID have a record, so
 * nothing here exists before the Meta popup finishes.
 *   override    token stored; the callback URL still has to be subscribed
 *   not_on_app  Meta reports the number is not on the WhatsApp Business app: the user chooses
 *   register    API-only path: the number still has to be registered (needs a PIN)
 *   sync        coexistence: the contacts and history syncs have to be requested (Meta gives 24 hours)
 *   templates   bring the message templates across
 *   done
 */
export type OnboardingStep = 'override' | 'not_on_app' | 'register' | 'sync' | 'templates' | 'done';

/** The two Embedded Signup success events: coexistence (Business app number) or the plain new-number flow. */
export type SignupEvent = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' | 'FINISH';

export type SyncType = 'contacts' | 'history';

/** `requesting` is held while the request to Meta is in flight, so a double click can't send it twice. */
export interface SyncStatus {
  /** `skipped`: the user chose not to request it, and Meta allows each only once, so it can't be asked for later. */
  state: 'none' | 'requesting' | 'requested' | 'failed' | 'skipped';
  /** When the state last changed. */
  at?: number;
  error?: string;
}

export interface OnboardingState {
  step: OnboardingStep;
  event: SignupEvent;
  updatedAt: number;
  /** The last thing that went wrong in this step, shown with a way to try again. */
  error?: string;
  /** The previous provider's Messaging account, when the user said they own it. Not a secret. */
  templateSourceWabaId?: string;
}

/** phoneNumbers/{phoneNumberId} */
export interface PhoneNumberDoc {
  userId: string;
  wabaId: string;
  phoneNumberId: string;
  encAccessToken?: EncryptedToken;
  overrideUrl?: string;
  activatedAt?: number;
  lastRelayCall?: number;
  usage?: Usage;
  /** The number as people know it, e.g. "+1 555-339-3615". Filled from Meta; falls back to the ID. */
  displayPhoneNumber?: string;
  /** Template-message counts per window, written by the relay (see helpers/rateLimiter.ts). */
  rateState?: RateState;
  /** Per-number override of the default rate limits. Set by us, never by the customer. */
  rateLimits?: RateLimitOverride;
  /** Wizard progress. Written only by the Functions. */
  onboarding: OnboardingState;
  /** The user chose to onboard without a callback URL: nothing of theirs receives incoming messages. */
  callbackSkipped?: boolean;
  /** Whether the number may send, as of the last read from Meta. See NumberHealth. */
  health?: NumberHealth;
  displayName?: DisplayNameState;
  /** Templates Meta paused, disabled, rejected or deleted, keyed `name|language`. */
  templates?: Record<string, TemplateGate>;
  /** When Meta was last really asked (a refresh is refused within ten minutes of it). Not set by a refused send. */
  metaFetchedAt?: number;
  /** From Meta, after onboarding: whether the number is also on the WhatsApp Business app. */
  isOnBizApp?: boolean;
  platformType?: string;
  /** Meta's status for the number as last seen (CONNECTED, ...), or DEREGISTERED after deregisterNumber. */
  metaStatus?: string;
  /** When each Meta data sync was requested. The data itself goes to the customer's URL and is never kept here. */
  sync?: Partial<Record<SyncType, SyncStatus>>;
}

/**
 * A number as the dashboard and the MCP see it (listNumbers, getNumber). Built from an explicit
 * list of fields (see helpers/numberView.ts), so the stored token can never be in it.
 */
/** What to do next for a number's onboarding step, in words an AI tool can follow. */
export interface NextStep {
  step: OnboardingStep;
  title: string;
  instruction: string;
  /** The tools (API calls of the same name) the instruction mentions. */
  tools: string[];
}

export interface NumberView {
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber?: string;
  overrideUrl?: string;
  callbackSkipped?: boolean;
  health?: NumberHealth;
  displayName?: DisplayNameState;
  templates?: Record<string, TemplateGate>;
  metaFetchedAt?: number;
  activatedAt?: number;
  lastRelayCall?: number;
  usage?: Usage;
  rateState?: RateState;
  rateLimits?: RateLimitOverride;
  onboarding: OnboardingState;
  /** Where the wizard is, worked out from the record (see effectiveStep). */
  step: OnboardingStep;
  /** What to do next at that step. */
  next: NextStep;
  /** Whether a Meta token is stored, so the number can send. False after a lost-key reset. */
  hasToken: boolean;
  isOnBizApp?: boolean;
  platformType?: string;
  metaStatus?: string;
  sync?: Partial<Record<SyncType, SyncStatus>>;
}

/** POST /listNumbers (a Firebase token or `apiKey` in the body). */
export interface ListNumbersResponse extends ApiResponse {
  numbers: NumberView[];
}

/**
 * Something about a number that needs the user's attention, for a chip on the dashboard and for an AI tool.
 * Written by us for the cases we know, in Meta's words for any other.
 */
export interface HealthReason {
  /** Which chip it belongs to: the status, the business (not verified), or the display name. */
  chip: 'status' | 'business' | 'name';
  /** A few words, for the top of the popup. */
  title: string;
  /** What is wrong and what it means for sending. */
  message: string;
  /** What to do about it. */
  action: string;
  /** Where to do it, when we know a place. */
  link?: string;
  /** Which part of the account Meta raised it on (WABA, PHONE_NUMBER, BUSINESS), or MESSAGE for a refusal. */
  scope: string;
  code?: number;
  /**
   * disabled refuses every send, blocked refuses template (business-initiated) sends, limited caps them at a few
   * a day, and info is shown only.
   */
  severity: 'disabled' | 'blocked' | 'limited' | 'info';
  /** What raised it. A notification may clear only the cause it is about, so a lifted ban leaves a payment problem. */
  cause: GateCause;
  /** When this was learned (epoch ms): an older notification never overrides a newer one. */
  at: number;
  /** For a restriction or pause with a known end (epoch ms): it stops counting by itself after that. */
  until?: number;
}

export type GateCause = 'ban' | 'review' | 'connection' | 'restriction' | 'payment' | 'name' | 'quality' | 'cooldown' | 'limited' | 'business' | 'meta';

/**
 * Whether a number may send, as of the last time it was read from Meta (the dashboard's refresh, or an
 * AI tool's get_number, or a send Meta refused). It is not re-checked on its own: the user fixes the
 * problem and refreshes.
 *   ok        nothing in the way
 *   limited   the number itself is limited (a display name not approved yet): few template messages a day
 *   blocked   the account or number is blocked: only free-form replies go through
 *   disabled  the account is banned, rejected or disconnected: nothing goes through
 * `status` is worked out from `reasons` (see gates.ts) every time they change.
 */
export interface NumberHealth {
  status: 'ok' | 'limited' | 'blocked' | 'disabled';
  reasons: HealthReason[];
  /** Meta's messaging limit tier, e.g. TIER_250, when it was last read or announced. Our daily limit never goes above it. */
  tier?: string;
  /** Whether Meta has verified the business. Only explains the tier; it gates nothing itself. */
  businessVerified?: boolean;
}

/** A template Meta paused, disabled, rejected or deleted: sends of it are refused. Templates in good standing are not stored. */
export interface TemplateGate {
  status: string;
  reason?: string;
  at: number;
}

/** One thing Meta told us (a webhook), or that a refresh found different, kept for the dashboard's Notifications. */
export interface NotificationDoc {
  eventAt: number;
  receivedAt: number;
  /** Meta's webhook field, or `refresh` for what a refresh found. */
  field: string;
  event?: string;
  title: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  /** Meta's payload for the event: account-level facts only, never a message. */
  value?: unknown;
}

/** What GET /numbers/<id>/notifications returns for one. */
export type NotificationView = Omit<NotificationDoc, 'value'> & { id: string; value?: unknown };

export interface NotificationsResponse extends ApiResponse {
  notifications: NotificationView[];
  /** Pass as `before` to get the next, older page. Absent when there are no more. */
  nextBefore?: number;
}

/** The number's display name and any change waiting for Meta's review. */
export interface DisplayNameState {
  /** When this was learned (epoch ms). */
  at?: number;
  name?: string;
  status?: string;
  requestedName?: string;
  requestedStatus?: string;
}

/** One live read from Meta: what it said, or why the read failed. Each part is separate so one failure hides nothing else. */
export type MetaPart<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** What Meta says about a number and its account right now. Never holds the token. */
export interface MetaSnapshot {
  /** Status, display name and its approval, quality rating, Business app, account mode. */
  phone: MetaPart<Record<string, unknown>>;
  /** The number's messaging limit tier, e.g. TIER_250. */
  messagingLimit: MetaPart<unknown>;
  /** The Messaging account: name, currency, review and business verification status. */
  waba: MetaPart<Record<string, unknown>>;
  /** Who owns the Messaging account. */
  ownership: MetaPart<Record<string, unknown>>;
  /** The apps subscribed to the account, with any callback URL override. */
  subscribedApps: MetaPart<unknown[]>;
  /** The numbers Meta lists under the account. */
  phoneNumbers: MetaPart<unknown[]>;
  /** The stored token's own details: type, scopes, expiry and the WABAs it was granted. */
  token: MetaPart<{ type?: string; isValid?: boolean; scopes: string[]; expiresAt?: number; dataAccessExpiresAt?: number; grantedWabaIds: string[] }>;
}

/** POST /getNumber (a Firebase token or `apiKey` in the body). */
export interface GetNumberResponse extends ApiResponse {
  number: NumberView;
  limits: RelayLimitsResponse;
  /** Live details from Meta. Only on a refresh (`?refresh=true`, with the key, which opens the stored token). */
  meta?: MetaSnapshot;
  /** When Meta may be asked again, an epoch time in ms. */
  nextRefreshAt?: number;
  /** Why `meta` is missing, when a key was given. */
  metaError?: string;
}

export interface ExchangeCodeRequest {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  apiKey: string;
  /** Which Embedded Signup success event the popup sent. */
  event: SignupEvent;
}

/** The answer to exchangeCode and setWebhook while a number is in the wizard. */
export interface OnboardingResponse extends ApiResponse {
  step?: OnboardingStep;
  /** What to do next, once the step has moved. */
  next?: NextStep;
  isOnBizApp?: boolean;
}

export interface StartSyncRequest {
  phoneNumberId: string;
  apiKey: string;
  syncType: SyncType;
}

export interface SetOnboardingStepRequest {
  phoneNumberId: string;
  apiKey: string;
  step: 'register' | 'templates' | 'done';
}

export interface DeregisterNumberRequest {
  phoneNumberId: string;
  apiKey: string;
}

export interface DisconnectNumberRequest {
  phoneNumberId: string;
  apiKey: string;
  /** Also take an API-only number off the Cloud API. Never done for a number that is on the Business app. */
  deregister: boolean;
}

export interface DisconnectNumberResponse extends ApiResponse {
  /** The number is also on the WhatsApp Business app, so the user still has to disconnect it there. */
  coexistence?: boolean;
  deregistered?: boolean;
}

/** POST templates/<phoneNumberId>/migrate (the key is the bearer token). */
export interface MigrateTemplatesRequest {
  sourceWabaId: string;
}

export interface MigrateTemplatesResponse extends ApiResponse {
  /** `unreadable`: our token can't reach the source account, so the user has to ask their provider. */
  outcome?: 'unreadable' | 'done';
  migrated?: number;
  failed?: { id: string; reason: string }[];
}

/** POST templates/<phoneNumberId>/import (the key is the bearer token). */
export interface ImportTemplatesRequest {
  /** Meta's template list as the previous provider exported it (the GET message_templates response, or its `data`). */
  templates: unknown;
}

export interface ImportTemplatesResponse extends ApiResponse {
  created?: number;
  failed?: { name: string; language: string; reason: string }[];
}

export type TestEventType = 'message' | 'echo' | 'contacts' | 'history';

export interface SendTestEventsRequest {
  overrideCallbackUrl: string;
}

export interface SendTestEventsResponse extends ApiResponse {
  /** What our request to the customer's URL got back, per event. The codes are not returned. */
  results?: Record<TestEventType, { ok: boolean; status?: number; ms?: number; error?: string }>;
  /** Seconds to wait before the next send, when one went out too recently. */
  retryAfter?: number;
}

export interface VerifyTestCodesRequest {
  codes: Partial<Record<TestEventType, string>>;
}

export interface VerifyTestCodesResponse extends ApiResponse {
  correct?: Record<TestEventType, boolean>;
}

/** GET /relayMessage/<id>/limits (the key is the bearer token). */
export interface RelayLimitsResponse extends ApiResponse {
  /** Only template messages are limited; free-form replies are not. */
  appliesTo: 'template messages';
  enabled: boolean;
  windows: Record<'minute' | 'hour' | 'day', { accepted: number; attempted: number; previousAccepted: number; limit: number; remaining: number; resetsAt: string; resetsInSeconds: number }>;
}

export interface SetWebhookRequest {
  phoneNumberId: string;
  apiKey: string;
  /** Where Meta sends incoming messages and events. Leave it out, with `noCallback`, to receive none. */
  overrideCallbackUrl?: string;
  /** Onboard without a callback URL: incoming messages go to Watobot, which discards them. */
  noCallback?: boolean;
}

export interface SetDisplayNameRequest {
  phoneNumberId: string;
  apiKey: string;
  displayName: string;
}

export interface SkipSyncRequest {
  phoneNumberId: string;
  apiKey: string;
}

export interface RegisterNumberRequest {
  phoneNumberId: string;
  apiKey: string;
  /** The 6-digit two-step verification PIN to set. Keep it: Meta asks for it to change or delete the number. */
  pin: string;
}

export interface RotateKeyRequest {
  oldApiKey: string;
  newApiKey: string;
}

export interface VerifyOtpRequest {
  phone: string;
  code: string;
  apiKey?: string;
  resetApiKey?: boolean;
}

/** Every Function answers with this shape; failures carry `error`. */
export interface ApiResponse {
  ok: boolean;
  error?: string;
}

export interface SendOtpResponse extends ApiResponse {}
export interface VerifyOtpResponse extends ApiResponse {
  token?: string;
  needsApiKey?: boolean;
}
export interface JoinWaitlistResponse extends ApiResponse {
  count?: number;
}
