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
 * nothing here exists before the Meta popup finishes. A record without `onboarding` is a number
 * onboarded before the wizard existed, and counts as done.
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
  state: 'none' | 'requesting' | 'requested' | 'failed';
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
  onboarding?: OnboardingState;
  /** From Meta, after onboarding: whether the number is also on the WhatsApp Business app. */
  isOnBizApp?: boolean;
  platformType?: string;
  /** When each Meta data sync was requested. The data itself goes to the customer's URL and is never kept here. */
  sync?: Partial<Record<SyncType, SyncStatus>>;
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

export interface NumberStatusResponse extends ApiResponse {
  status?: string;
  codeVerificationStatus?: string;
  isOnBizApp?: boolean;
  platformType?: string;
}

export interface MigrateTemplatesRequest {
  phoneNumberId: string;
  apiKey: string;
  sourceWabaId: string;
}

export interface MigrateTemplatesResponse extends ApiResponse {
  /** `unreadable`: our token can't reach the source account, so the user has to ask their provider. */
  outcome?: 'unreadable' | 'done';
  migrated?: number;
  failed?: { id: string; reason: string }[];
}

export interface ImportTemplatesRequest {
  phoneNumberId: string;
  apiKey: string;
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

export interface SetWebhookRequest {
  phoneNumberId: string;
  apiKey: string;
  overrideCallbackUrl: string;
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
