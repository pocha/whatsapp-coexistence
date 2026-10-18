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

type Get = (path: string) => Promise<any>;

/** Fields too large or pointless to hand back (the verified-name certificate is a long base64 blob). */
const SKIPPED_FIELDS = new Set(['certificate']);

/**
 * Reads `fields` of a node. Meta answers a field it doesn't know (for this version or this kind of
 * node) with "(#100) Tried accessing nonexisting field (x)" and no data at all, so such a field is
 * dropped and the read retried, and the dropped names come back as `unavailableFields`.
 */
export async function readFieldsSkippingUnknown(get: Get, node: string, fields: string[]): Promise<Record<string, unknown>> {
  const left = [...fields];
  const dropped: string[] = [];
  while (left.length) {
    try {
      const body = await get(`${node}?fields=${left.join(',')}`);
      return dropped.length ? { ...body, unavailableFields: dropped } : body;
    } catch (err) {
      const unknown = /nonexisting field \((\w+)\)/.exec((err as Error).message)?.[1];
      if (!unknown || !left.includes(unknown)) throw err;
      left.splice(left.indexOf(unknown), 1);
      dropped.push(unknown);
    }
  }
  return { unavailableFields: dropped };
}

/**
 * Reads every field Meta lists for a node: `?metadata=1` names them (and the edges the node has, which
 * come back as `availableEdges`), then they are read together. If one is refused for another reason (a
 * permission, say), each is read on its own, and the ones that failed come back as `unreadableFields`.
 * `fallback` is used if Meta won't list them.
 */
export async function readAllFields(get: Get, node: string, fallback: string[]): Promise<Record<string, unknown>> {
  let names = fallback;
  let edges: string[] | undefined;
  try {
    const described = await get(`${node}?metadata=1`);
    const listed = ((described?.metadata?.fields ?? []) as { name?: string }[]).map((f) => f.name).filter((n): n is string => Boolean(n));
    if (listed.length) names = listed;
    if (described?.metadata?.connections) edges = Object.keys(described.metadata.connections);
  } catch {
    // Use the fallback list.
  }
  names = names.filter((n) => !SKIPPED_FIELDS.has(n));
  const withEdges = (body: Record<string, unknown>) => (edges ? { ...body, availableEdges: edges } : body);
  try {
    return withEdges(await readFieldsSkippingUnknown(get, node, names));
  } catch {
    const read: Record<string, unknown> = {};
    const unreadable: Record<string, string> = {};
    await Promise.all(
      names.map(async (name) => {
        try {
          Object.assign(read, await get(`${node}?fields=${name}`));
        } catch (err) {
          unreadable[name] = (err as Error).message.replace(/^Graph API error \(\d+\): /, '').slice(0, 160);
        }
      }),
    );
    return withEdges({ ...read, unreadableFields: unreadable });
  }
}

const PHONE_FIELDS = ['display_phone_number', 'verified_name', 'name_status', 'quality_rating', 'status', 'code_verification_status', 'platform_type', 'is_on_biz_app', 'account_mode', 'health_status'];
const WABA_FIELDS = ['name', 'currency', 'timezone_id', 'account_review_status', 'business_verification_status', 'ownership_type', 'on_behalf_of_business_info', 'health_status'];

/**
 * Reads a number and its Messaging account from Meta with the stored token, as separate reads so that
 * one Meta refusing (or not knowing a field) leaves the rest. Asks for every field Meta lists for the
 * number and the account. Read-only.
 */
export async function readMetaSnapshot(args: { phoneNumberId: string; wabaId: string; accessToken: string }): Promise<MetaSnapshot> {
  const { phoneNumberId, wabaId, accessToken } = args;
  const get: Get = (path) => graphGet(path, accessToken);
  const [phone, messagingLimit, waba, ownership, subscribedApps, phoneNumbers, token] = await Promise.all([
    attempt(() => readAllFields(get, `/${id(phoneNumberId)}`, PHONE_FIELDS)),
    attempt(async () => (await get(`/${id(phoneNumberId)}?fields=whatsapp_business_manager_messaging_limit`)).whatsapp_business_manager_messaging_limit),
    attempt(() => readAllFields(get, `/${id(wabaId)}`, WABA_FIELDS)),
    attempt(() => readFieldsSkippingUnknown(get, `/${id(wabaId)}`, ['ownership_type', 'on_behalf_of_business_info'])),
    attempt(async () => (await get(`/${id(wabaId)}/subscribed_apps`)).data ?? []),
    attempt(async () => (await get(`/${id(wabaId)}/phone_numbers?fields=id,display_phone_number&limit=100`)).data ?? []),
    attempt(() => debugToken(accessToken, config.metaAppId, config.metaAppSecret)),
  ]);
  return { phone, messagingLimit, waba, ownership, subscribedApps, phoneNumbers, token };
}
