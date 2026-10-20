import { createHash } from 'node:crypto';
import { deriveHealth, type DerivedHealth } from './health';
import { mergeRefresh, presentHealth } from './gates';
import { readMetaSnapshot } from './metaSnapshot';
import { addNotification, readNumber, setHealth } from './model';
import type { MetaSnapshot } from './types';

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
