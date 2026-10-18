import { deriveHealth, type DerivedHealth } from './health';
import { readMetaSnapshot } from './metaSnapshot';
import { setHealth } from './model';
import type { MetaSnapshot } from './types';

/**
 * Reads the number from Meta and, if that gave a status, stores it as the number's health and display
 * name. If the read didn't (Meta refused the phone read, say) what was stored stays. Returns the live
 * snapshot, and what was stored if anything.
 */
export async function refreshHealth(args: { phoneNumberId: string; wabaId: string; accessToken: string }): Promise<{ meta: MetaSnapshot; derived: DerivedHealth | null }> {
  const meta = await readMetaSnapshot(args);
  const derived = deriveHealth(meta, Date.now());
  if (derived) await setHealth(args.phoneNumberId, derived.health, derived.displayName);
  return { meta, derived };
}
