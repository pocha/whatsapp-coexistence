import { logger } from 'firebase-functions/v2';
import { config } from './config';

// Overridable so tests can point this at a local stub instead of the real
// Meta API for end-to-end happy-path coverage.
export function graphApiBase(): string {
  return process.env.GRAPH_API_BASE ?? `https://graph.facebook.com/${config.graphApiVersion}`;
}

async function graphFetch(path: string, init: RequestInit, timeoutMs = 10000): Promise<any> {
  const res = await fetch(`${graphApiBase()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json();
  if (!res.ok) {
    logger.warn('Graph API call failed', { method: init.method, path: path.split('?')[0], status: res.status, metaError: body?.error });
    throw new Error(`Graph API error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Exchanges the Embedded Signup `code` for a WABA-scoped access token. */
export async function exchangeCodeForToken(code: string, appId: string, appSecret: string): Promise<string> {
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  const body = await graphFetch(`/oauth/access_token?${params.toString()}`, { method: 'GET' });
  return body.access_token as string;
}

/**
 * Subscribes this app to the business's WABA events, with Meta delivering
 * them straight to `overrideCallbackUrl` instead of this app's own webhook —
 * the "onboard, then get out of the message path" step.
 */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
  overrideCallbackUrl: string,
  verifyToken: string,
): Promise<void> {
  await graphFetch(`/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      override_callback_uri: overrideCallbackUrl,
      verify_token: verifyToken,
    }),
  });
}

/** The number as people see it, e.g. "+1 555-339-3615". */
export async function getDisplayPhoneNumber(phoneNumberId: string, accessToken: string): Promise<string | undefined> {
  const body = await graphFetch(`/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return body.display_phone_number as string | undefined;
}

/**
 * Registers a business phone number for Cloud API use. Meta requires this after Embedded Signup
 * for a new number (not for a coexistence number, which is already registered), and it sets the
 * number's two-step verification PIN.
 */
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<void> {
  await graphFetch(`/${encodeURIComponent(phoneNumberId)}/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  }, 60000); // registering can take Meta well over the usual 10 seconds
}

/**
 * Confirms the access token can read this WABA. Used to make sure a caller
 * really holds a valid token for it before we do anything on its behalf.
 */
export async function verifyWabaAccess(wabaId: string, accessToken: string): Promise<void> {
  await graphFetch(`/${encodeURIComponent(wabaId)}?fields=id`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export interface PhoneNumberInfo {
  status?: string;
  codeVerificationStatus?: string;
  isOnBizApp?: boolean;
  platformType?: string;
}

/**
 * Where a number stands with Meta: connected or not, verified or not, and whether it is also on
 * the WhatsApp Business app (coexistence: `is_on_biz_app` true with `platform_type` CLOUD_API).
 */
export async function getPhoneNumberInfo(phoneNumberId: string, accessToken: string): Promise<PhoneNumberInfo> {
  const body = await graphFetch(
    `/${encodeURIComponent(phoneNumberId)}?fields=status,code_verification_status,is_on_biz_app,platform_type`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return {
    status: body.status,
    codeVerificationStatus: body.code_verification_status,
    isOnBizApp: typeof body.is_on_biz_app === 'boolean' ? body.is_on_biz_app : undefined,
    platformType: body.platform_type,
  };
}

/**
 * Asks Meta to send a coexistence number's contacts (`smb_app_state_sync`) or message history
 * (`history`) to the callback URL. Meta allows each only once per onboarding, and the data goes to
 * the customer's endpoint, not to us.
 */
export async function requestSmbAppData(
  phoneNumberId: string,
  accessToken: string,
  syncType: 'smb_app_state_sync' | 'history',
): Promise<void> {
  await graphFetch(`/${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
  });
}

export interface MigrateTemplatesPage {
  migrated: string[];
  failed: Record<string, string>;
}

/** Copies one batch (up to 500) of approved templates from `sourceWabaId` into `destWabaId`. */
export async function migrateTemplatesPage(
  destWabaId: string,
  sourceWabaId: string,
  accessToken: string,
  pageNumber: number,
): Promise<MigrateTemplatesPage> {
  const body = await graphFetch(
    `/${encodeURIComponent(destWabaId)}/migrate_message_templates`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_waba_id: sourceWabaId, page_number: pageNumber }),
    },
    30000,
  );
  return { migrated: body.migrated_templates ?? [], failed: body.failed_templates ?? {} };
}

/** Creates one message template; Meta reviews it, so it comes back pending. */
export async function createTemplate(wabaId: string, accessToken: string, payload: unknown): Promise<void> {
  await graphFetch(
    `/${encodeURIComponent(wabaId)}/message_templates`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    20000,
  );
}

/**
 * Takes a number off the Cloud API: it stops sending and receiving, and can be registered again
 * (or moved to another provider). Meta refuses it for a number that is also on the WhatsApp
 * Business app, and allows 10 requests per number in 72 hours. It takes no PIN.
 */
export async function deregisterPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
  await graphFetch(`/${encodeURIComponent(phoneNumberId)}/deregister`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Stops this app receiving the Messaging account's webhooks (and removes the callback URL override). */
export async function unsubscribeApp(wabaId: string, accessToken: string): Promise<void> {
  await graphFetch(`/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
