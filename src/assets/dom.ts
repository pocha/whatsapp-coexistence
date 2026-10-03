/** The element with this id. Throws if the page doesn't have it, so a typo fails loudly. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

/** The message of a caught error (anything can be thrown). */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
