import { config } from '../config';

const GRAPH_BASE = `https://graph.facebook.com/${config.graphApiVersion}`;

async function graphFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${GRAPH_BASE}${path}`, init);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Graph API error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Exchanges the Embedded Signup `code` for a WABA-scoped access token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    code,
  });
  const body = await graphFetch(`/oauth/access_token?${params.toString()}`, { method: 'GET' });
  return body.access_token as string;
}

/**
 * Subscribes this app to the customer's WABA events. Pass `overrideCallbackUrl`
 * to have Meta deliver events straight to the customer's own webhook instead
 * of this app's — that's the "onboard, then get out of the message path" step.
 */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
  overrideCallbackUrl?: string,
): Promise<void> {
  const body: Record<string, string> = {};
  if (overrideCallbackUrl) {
    body.override_callback_uri = overrideCallbackUrl;
    body.verify_token = config.webhookVerifyToken;
  }
  await graphFetch(`/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** Sends a free-form text message — used by the "test message" demo feature. */
export async function sendTextMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
): Promise<unknown> {
  return graphFetch(`/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

/** Creates a message template — used by the "create template" demo feature. */
export async function createMessageTemplate(
  wabaId: string,
  accessToken: string,
  template: { name: string; category: string; language: string; bodyText: string },
): Promise<unknown> {
  return graphFetch(`/${wabaId}/message_templates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: template.name,
      category: template.category,
      language: template.language,
      components: [{ type: 'BODY', text: template.bodyText }],
    }),
  });
}
