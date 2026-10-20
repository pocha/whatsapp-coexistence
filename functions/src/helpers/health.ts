import { createHash } from 'node:crypto';
import { config } from './config';
import { LINKS, RULES, issueFrom } from './rules';
import { REFRESH_MIN_INTERVAL_MS, mergeRefresh, presentHealth, tierLimit } from './gates';
import { debugToken, graphGet } from './graphApi';
import { addNotification, readNumber, setHealth } from './model';
import type { DisplayNameState, Issue, MetaPart, MetaSnapshot, NumberHealth, Scope, TemplateGate, Why } from './types';

// Turns what Meta says about a number (its health_status and a few fields) into the issues we act on. The
// wording is in the rows of rules.ts. A known Meta error code, the number's status, the account review and a
// red quality rating each have a row; any other error Meta gives is stored in Meta's own words.

/** When Meta may be asked again about a number, an epoch time in ms (now, if it never was asked). */
export const nextRefreshAt = (metaFetchedAt: number | undefined, now: number) => (metaFetchedAt ? Math.max(now, metaFetchedAt + REFRESH_MIN_INTERVAL_MS) : now);

interface HealthEntity {
  entity_type?: string;
  can_send_message?: string;
  errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
  additional_info?: string[];
}

const isCalling = (code?: number, text?: string) => code === 138024 || code === 138025 || /\bSIP\b/.test(text ?? '');

const SCOPE_OF: Record<string, Scope> = { WABA: 'account', PHONE_NUMBER: 'phone', BUSINESS: 'business' };
const SCOPE_NAME: Record<Scope, string> = { account: 'account', phone: 'number', business: 'business', display_name: 'display name' };

export interface DerivedHealth {
  health: NumberHealth;
  displayName: DisplayNameState;
}

export function deriveHealth(snapshot: Pick<MetaSnapshot, 'phone' | 'messagingLimit'> & Partial<Pick<MetaSnapshot, 'waba'>>, now: number): DerivedHealth | null {
  if (!snapshot.phone.ok) return null;
  const phone = snapshot.phone.data as Record<string, any>;
  if (!phone.health_status) return null;

  const health: NumberHealth = {};
  const add = (scope: Scope, why: Why, issue: Issue) => {
    health[scope] = { ...health[scope], [why]: issue };
  };
  /** Adds the issue a row stands for. False when there is no such row. */
  const fromRow = (key: string, ctx: Record<string, unknown> = {}) => {
    const rule = RULES[key];
    if (!rule?.scope || !rule.why || !rule.send) return false;
    add(rule.scope, rule.why, issueFrom({ ...rule, send: rule.send }, ctx, now));
    return true;
  };

  for (const entity of (phone.health_status.entities ?? []) as HealthEntity[]) {
    const state = entity.can_send_message;
    const scope = SCOPE_OF[entity.entity_type ?? ''];
    if (!state || state === 'AVAILABLE' || !scope) continue;
    // Only these restrict sending; a business that is LIMITED only because it is unverified is normal (its own row).
    const send = state === 'BLOCKED' && scope !== 'business' ? 'block' : state === 'LIMITED' && scope === 'phone' ? 'limit' : undefined;
    let explained = false;

    for (const error of entity.errors ?? []) {
      if (isCalling(error.error_code, error.error_description)) continue;
      if (fromRow(`code:${error.error_code}`)) explained = true;
      else if (send && error.error_code) {
        add(scope, `code_${error.error_code}`, {
          send,
          title: `Meta flagged the ${SCOPE_NAME[scope]}`,
          message: `${error.error_description ?? 'Meta gave no description.'} ${error.possible_solution ?? 'Check WhatsApp Manager for details, fix what it names, then refresh.'}`,
          link: LINKS.manager,
          at: now,
          code: error.error_code,
          ...(send === 'limit' ? { cap: RULES['phone_status:FLAGGED'].cap } : {}),
        });
        explained = true;
      }
    }
    for (const note of entity.additional_info ?? []) if (/display name/i.test(note) && fromRow('phone_note:display_name', { note })) explained = true;

    // Blocked or limited with no reason Meta gave: say so, so the status is never unexplained.
    if (send && !explained) {
      add(scope, 'meta', {
        send,
        title: `Meta says this ${SCOPE_NAME[scope]} is ${send === 'block' ? 'blocked' : 'limited'}`,
        message: 'Meta gave no reason. Check WhatsApp Manager, fix what it names, then refresh.',
        link: LINKS.manager,
        at: now,
        ...(send === 'limit' ? { cap: RULES['phone_status:FLAGGED'].cap } : {}),
      });
    }
  }

  // The number's own status, the account's review and the quality rating.
  fromRow(`phone_status:${phone.status}`);
  const waba = snapshot.waba?.ok ? (snapshot.waba.data as Record<string, any>) : undefined;
  const review = String(waba?.account_review_status ?? '');
  if (review && review !== 'APPROVED') fromRow('review', { status: review });
  if (/RED/i.test(String(phone.quality_rating ?? ''))) fromRow('quality:RED');

  // Meta's daily messaging limit.
  const tierName = snapshot.messagingLimit.ok && typeof snapshot.messagingLimit.data === 'string' ? snapshot.messagingLimit.data : undefined;
  const tier = tierLimit(tierName);
  if (tier) health.tier = tier;

  const displayName: DisplayNameState = {
    at: now,
    name: phone.verified_name,
    status: phone.name_status,
    requestedName: phone.new_display_name,
    requestedStatus: phone.new_name_status,
  };
  return { health, displayName };
}

/** What a refused send tells us about the number, from Meta's error code. */
export function issuesFromRefusal(error: { code?: number; message?: string } | undefined, now: number): { scope: Scope; why: Why; issue: Issue }[] {
  const rule = RULES[`refusal:${error?.code}`];
  if (!rule?.scope || !rule.why || !rule.send) return [];
  return [{ scope: rule.scope, why: rule.why, issue: { ...issueFrom({ ...rule, send: rule.send }, { detail: error?.message ?? 'Meta refused the send.' }, now), code: error?.code } }];
}

/** A refused send that names a template Meta has paused or disabled, as that template's entry. */
export function templateGateFromRefusal(error: { code?: number; message?: string } | undefined, templateKey: string | undefined, now: number): { key: string; gate: TemplateGate } | null {
  const status = error?.code === 132015 ? 'PAUSED' : error?.code === 132016 ? 'DISABLED' : undefined;
  return status && templateKey ? { key: templateKey, gate: { status, reason: error?.message, at: now } } : null;
}


/**
 * Reads the number from Meta and, if that gave a status, stores it as the number's health and display name,
 * and stamps when Meta was asked. A refresh is Meta's whole picture now, so it replaces what notifications
 * had set, except anything that arrived while it ran. If it disagrees with what was stored, that is written
 * to the notifications, so a wrong state shows up. If the read didn't give a status, what was stored stays.
 */
export async function refreshHealth(args: { phoneNumberId: string; wabaId: string; accessToken: string }): Promise<{ meta: MetaSnapshot; derived: DerivedHealth | null }> {
  const startedAt = Date.now();
  const meta = await readMetaSnapshot(args);
  const now = Date.now();
  const derived = deriveHealth(meta, now);
  if (!derived) return { meta, derived };

  const before = (await readNumber(args.phoneNumberId))?.health;
  const merged = mergeRefresh(before, derived.health, startedAt);
  await setHealth(args.phoneNumberId, merged, derived.displayName, now);

  const wasStatus = before ? presentHealth(before, now).status : undefined;
  const nowStatus = presentHealth(merged, now).status;
  if (before && wasStatus !== nowStatus) {
    const id = createHash('sha1').update(`refresh|${args.phoneNumberId}|${now}`).digest('hex');
    await addNotification(args.phoneNumberId, id, {
      eventAt: now,
      receivedAt: now,
      field: 'refresh',
      title: `Refresh found the number ${nowStatus}`,
      message: `Asking Meta now shows the number as ${nowStatus}; it was stored as ${wasStatus}. What Meta says now replaces what we had.`,
      severity: nowStatus === 'ok' ? 'info' : 'warning',
    }).catch(() => undefined);
  }
  return { meta, derived: { ...derived, health: merged } };
}


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
