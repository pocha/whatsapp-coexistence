import { debugToken, graphGet } from './graphApi';
import { config } from './config';
import type { MetaPart, MetaSnapshot } from './types';

async function attempt<T>(read: () => Promise<T>): Promise<MetaPart<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}

const id = encodeURIComponent;

/**
 * Reads a number and its Messaging account from Meta with the stored token, as separate reads so that
 * one Meta refusing (or not knowing a field) leaves the rest. Read-only.
 */
export async function readMetaSnapshot(args: { phoneNumberId: string; wabaId: string; accessToken: string }): Promise<MetaSnapshot> {
  const { phoneNumberId, wabaId, accessToken } = args;
  const get = (path: string) => graphGet(path, accessToken);
  const [phone, messagingLimit, waba, ownership, subscribedApps, phoneNumbers, token] = await Promise.all([
    attempt(() =>
      get(`/${id(phoneNumberId)}?fields=display_phone_number,verified_name,name_status,quality_rating,status,code_verification_status,platform_type,is_on_biz_app,account_mode,throttle`),
    ),
    attempt(async () => (await get(`/${id(phoneNumberId)}?fields=whatsapp_business_manager_messaging_limit`)).whatsapp_business_manager_messaging_limit),
    attempt(() => get(`/${id(wabaId)}?fields=name,currency,timezone_id,account_review_status,business_verification_status`)),
    attempt(() => get(`/${id(wabaId)}?fields=ownership_type,on_behalf_of_business_info`)),
    attempt(async () => (await get(`/${id(wabaId)}/subscribed_apps`)).data ?? []),
    attempt(async () => (await get(`/${id(wabaId)}/phone_numbers?fields=id,display_phone_number&limit=100`)).data ?? []),
    attempt(() => debugToken(accessToken, config.metaAppId, config.metaAppSecret)),
  ]);
  return { phone, messagingLimit, waba, ownership, subscribedApps, phoneNumbers, token };
}
