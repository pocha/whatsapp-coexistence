import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiFor, UserError, type Context } from './api';

const instructions = (SITE: string) => `Watobot lets a business use the WhatsApp Business app and the WhatsApp Cloud API on one number (coexistence), or run a number on the API alone.

First time: the person signs up at ${SITE} and creates their API key on the "API key" page (made in their browser, shown once). The page also shows how to connect it to an AI tool: as WATOBOT_API_KEY for the local server, or inside the connector address for the hosted one. You cannot create the key.

Onboarding a number, in order:
1. Ask whether the person wants incoming messages in an app of their own. If yes they need a callback URL that receives the WhatsApp events Meta sends: call check_callback_url, then send_test_events (optional, but it is the only way to know their endpoint stores the one-time history and contacts sync). Each event carries a code their endpoint prints or stores; ask for the four codes and call verify_test_codes. If they only send messages and reply in the WhatsApp Business app, they can have no callback URL: say plainly what that costs (no incoming messages or delivery receipts reach them, and the contacts and history sync is skipped for good, since Meta allows it once) and get their agreement.
2. Call start_onboarding_link with that callback URL (or none) and give the person the link. Meta's sign-up (Facebook login, the WhatsApp Business app's code or QR) can only be done by the person in their browser; no tool can do it.
3. Call get_number (or list_numbers) until the number appears. Every number carries "next": what to do at its current step, and the tools to use. Tell the person that, and follow it. Calls that move a number on (register_number, start_sync, skip_sync, set_onboarding_step) answer with the new "next", so after each one say what is next without asking again.

Sending: send_message through Watobot; template sends are limited per minute, hour and day. Call get_limits to see how much room is left and wait when remaining is 0.
A send Watobot refuses (403, or 429 with Retry-After) comes with issues: what is wrong, what the person has to do and where. Tell them, do not retry in a loop, and call get_number with refresh only after they say it is fixed. get_notifications shows what Meta has reported about the number.

deregister_number, disconnect_number, delete_template and skip_sync cannot be undone. Ask the person before calling them.`;

type Shape = Record<string, z.ZodTypeAny>;

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function createServer(ctx: Context): McpServer {
  const SITE = ctx.siteUrl;
  const { callFunction, callWithBearer } = apiFor(ctx);
  const server = new McpServer({ name: 'watobot', version: '0.1.0' }, { instructions: instructions(SITE) });

  function tool<S extends Shape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    options: { destructive?: boolean; readOnly?: boolean } = {},
  ) {
    server.registerTool(
      name,
      {
        description: options.destructive ? `${description} This cannot be undone: ask the person first.` : description,
        inputSchema: shape,
        annotations: { destructiveHint: options.destructive ?? false, readOnlyHint: options.readOnly ?? false },
      } as any, // the SDK's generics can't follow a shape passed through this helper; the zod shape is checked at the call sites
      (async (args: any): Promise<CallToolResult> => {
        try {
          return text(await run(args));
        } catch (err) {
          if (!(err instanceof UserError)) console.error(err);
          return { ...text(err instanceof UserError ? err.message : `Unexpected error: ${(err as Error).message}`), isError: true };
        }
      }) as any,
    );
  }

  const phoneNumberId = z.string().regex(/^\d{8,20}$/).describe('The number\'s phone number ID (from list_numbers), digits only');
  const callbackUrl = z.string().url().describe('The public https URL that receives the WhatsApp events');

  // ---- what the account has ----
  tool('list_numbers', 'Lists your numbers and where each is in onboarding (the "step"), whether it is also on the WhatsApp Business app, and when the syncs were requested.', {}, () => callWithBearer('GET', 'numbers'), { readOnly: true });
  tool(
    'get_number',
    'One number\'s state, its template-send limits and its sending status (ok, limit, block or disable, per scope: account, business, display_name and phone, with the issues, what to do about each and where; a disabled number, such as a banned or disconnected one, sends nothing). That is what was stored the last time Meta was asked. With refresh=true it asks Meta again (messaging limit tier, quality rating, display name, account review, ownership, the callback URL override, the token\'s scopes) and updates the status, but only once in ten minutes: ask again only after the person has fixed what the status names.',
    { phoneNumberId, refresh: z.boolean().optional() },
    (a) => callWithBearer('GET', `numbers/${a.phoneNumberId}${a.refresh ? '?refresh=true' : ''}`),
    { readOnly: true },
  );

  // ---- before the number exists ----
  tool('check_callback_url', 'Does Meta\'s handshake against your callback URL, to see it answers before onboarding.', { overrideCallbackUrl: callbackUrl }, (a) => callFunction('onboarding/callback-check', a), { readOnly: true });
  tool('send_test_events', 'Posts one test event of each kind (message, echo, contacts, history) to your callback URL, each with a code your endpoint should store. One send per 30 seconds.', { overrideCallbackUrl: callbackUrl }, (a) => callFunction('onboarding/test-events', a));
  tool(
    'verify_test_codes',
    'Says which of the codes the person read from their endpoint match the last send_test_events.',
    { message: z.string().optional(), echo: z.string().optional(), contacts: z.string().optional(), history: z.string().optional() },
    (codes) => callFunction('onboarding/test-codes', { codes }),
    { readOnly: true },
  );
  tool(
    'start_onboarding_link',
    'The link the person opens to finish onboarding in their browser: it skips the checks already done here and goes to Meta\'s sign-up. Give it after check_callback_url (and verify_test_codes, if they want that test) passed, or with no callback URL if they chose to have none.',
    { overrideCallbackUrl: callbackUrl.optional().describe('Leave out to onboard with no callback URL') },
    async (a) => `${SITE}/dashboard/waba/create.html?checks=done&callback=${a.overrideCallbackUrl ? encodeURIComponent(a.overrideCallbackUrl) : 'none'}\n\nThe person opens this, enters their API key, and completes Meta's sign-up (Facebook login, then the code or QR in the WhatsApp Business app). Then call get_number.`,
    { readOnly: true },
  );

  // ---- a number going through onboarding ----
  tool(
    'set_webhook',
    'Points the number\'s incoming events at a callback URL (checks it answers Meta\'s handshake first), or with noCallback=true at none: then incoming messages and delivery receipts reach no app of the person\'s, and the one-time contacts and history sync is skipped.',
    { phoneNumberId, overrideCallbackUrl: callbackUrl.optional(), noCallback: z.boolean().optional() },
    ({ phoneNumberId, ...body }) => callWithBearer('PUT', `numbers/${phoneNumberId}/webhook`, body),
  );
  tool(
    'set_display_name',
    'Asks Meta to review a new display name for the number. Only one change can be in review at a time, so it refuses while one is pending. Meta\'s decision takes a while: check get_number\'s displayName for the status, and do not ask again meanwhile.',
    { phoneNumberId, displayName: z.string().min(3) },
    ({ phoneNumberId, ...body }) => callWithBearer('PUT', `numbers/${phoneNumberId}/display-name`, body),
  );
  tool('skip_sync', 'Coexistence only: skips the contacts and history sync for good (Meta allows each once, within 24 hours of onboarding). Ask the person first.', { phoneNumberId }, (a) => callWithBearer('POST', `onboarding/${a.phoneNumberId}/sync/skip`), { destructive: true });
  tool('start_sync', 'Coexistence only: asks Meta to send the contacts, or the history, to the callback URL. Each can be requested once, contacts first, within 24 hours of onboarding.', { phoneNumberId, syncType: z.enum(['contacts', 'history']) }, ({ phoneNumberId, ...body }) => callWithBearer('POST', `onboarding/${phoneNumberId}/sync`, body));
  tool('register_number', 'API-only numbers: registers the number for the Cloud API with a six-digit PIN (two-step verification). Refused for a number on the WhatsApp Business app.', { phoneNumberId, pin: z.string().regex(/^\d{6}$/) }, ({ phoneNumberId, ...body }) => callWithBearer('POST', `numbers/${phoneNumberId}/register`, body));
  tool('set_onboarding_step', 'Moves the wizard on when the person chooses or confirms: "register" (API only, from "not on the app"), "templates" (after the syncs) or "done".', { phoneNumberId, step: z.enum(['register', 'templates', 'done']) }, ({ phoneNumberId, ...body }) => callWithBearer('PUT', `onboarding/${phoneNumberId}/step`, body));

  // ---- sending ----
  tool('send_message', 'Sends a message through Watobot to Meta. The body is Meta\'s messages body (messaging_product, to, type, ...). Template sends are limited; free-form replies are not.', { phoneNumberId, message: z.record(z.string(), z.unknown()).describe('Meta\'s /messages request body') }, (a) => callWithBearer('POST', `numbers/${a.phoneNumberId}/messages`, a.message));
  tool(
    'get_notifications',
    'What Meta has told Watobot about the number, newest first, kept for a month: a ban or restriction, a display name decision, a messaging limit change, a template paused or reinstated, a refresh that found something different. Pass `before` (the nextBefore of the last page) for older ones.',
    { phoneNumberId, limit: z.number().int().min(1).max(50).optional(), before: z.number().optional() },
    (a) => callWithBearer('GET', `numbers/${a.phoneNumberId}/notifications?limit=${a.limit ?? 20}${a.before ? `&before=${a.before}` : ''}`),
    { readOnly: true },
  );
  tool('get_limits', 'Where the number stands against its template-send limits per minute, hour and day: how many went through, how many are left, when each window resets.', { phoneNumberId }, (a) => callWithBearer('GET', `numbers/${a.phoneNumberId}/limits`), { readOnly: true });

  // ---- templates ----
  tool('list_templates', 'Lists the number\'s message templates with their status and quality_score (GREEN, YELLOW or RED, or UNKNOWN for a new one: how Meta rates customers\' reactions to it). Meta holds back or pauses messages on a template that is not green. It returns the first 100 templates only (no paging yet). The output is what import_templates takes.', { phoneNumberId }, (a) => callWithBearer('GET', `templates/${a.phoneNumberId}`), { readOnly: true });
  tool('create_template', 'Creates a message template (Meta\'s template body). Meta reviews it, which can take up to 24 hours.', { phoneNumberId, template: z.record(z.string(), z.unknown()) }, (a) => callWithBearer('POST', `templates/${a.phoneNumberId}`, a.template));
  tool('delete_template', 'Deletes every template with that name.', { phoneNumberId, name: z.string().min(1) }, (a) => callWithBearer('DELETE', `templates/${a.phoneNumberId}?name=${encodeURIComponent(a.name)}`), { destructive: true });
  tool('migrate_templates', 'Copies approved templates from the number\'s previous Messaging account (Watobot must be a partner on it). Says "unreadable" when it can\'t read that account: then ask the previous provider for an export and use import_templates.', { phoneNumberId, sourceWabaId: z.string().regex(/^\d{8,20}$/).describe('The previous Messaging account ID (previously called WABA ID)') }, (a) => callWithBearer('POST', `templatesBulk/${a.phoneNumberId}/migrate`, { sourceWabaId: a.sourceWabaId }));
  tool('import_templates', 'Creates templates from an export of the previous provider (Meta\'s message_templates response), up to 100 at a time.', { phoneNumberId, templates: z.unknown().describe('The exported list, or Meta\'s whole response') }, (a) => callWithBearer('POST', `templatesBulk/${a.phoneNumberId}/import`, { templates: a.templates }));

  // ---- leaving ----
  tool('deregister_number', 'API-only numbers: takes the number off the Cloud API (it can then be registered elsewhere). Refused for a number on the WhatsApp Business app: disconnect it in that app.', { phoneNumberId }, (a) => callWithBearer('POST', `numbers/${a.phoneNumberId}/deregister`), { destructive: true });
  tool('disconnect_number', 'What leaving Watobot does on Meta\'s side: unsubscribes Watobot from the number, and with deregister=true also de-registers an API-only number. Messages stop arriving.', { phoneNumberId, deregister: z.boolean().default(false) }, ({ phoneNumberId, ...body }) => callWithBearer('POST', `numbers/${phoneNumberId}/disconnect`, body), { destructive: true });

  return server;
}
