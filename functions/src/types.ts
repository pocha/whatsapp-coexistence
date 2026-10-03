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

/** Counters written by the relay, keyed by day (YYYY-MM-DD), ISO week (YYYY-Www) and month (YYYY-MM). */
export interface Usage {
  daily?: Record<string, number>;
  weekly?: Record<string, number>;
  monthly?: Record<string, number>;
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
}

export interface ExchangeCodeRequest {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  apiKey: string;
}

export interface SetWebhookRequest {
  phoneNumberId: string;
  apiKey: string;
  overrideCallbackUrl: string;
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
