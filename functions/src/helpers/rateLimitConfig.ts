// Rate limits for template messages sent through the relay. Edit the values here to tune them for every number.
// To start one number higher (an account moving over in good standing), set `limits` on its record
// (phoneNumbers/{id}.limits = { minute, hour, day }, with the Admin SDK or the Firebase console, never by the
// customer): it applies at once and then only grows.
//
// How a window's limit is worked out (see rateLimiter.ts):
//
//   earned = max(stored limit, floor, previous × (1 + growthPercent / 100) + headroomSigmas × √previous)
//   limit  = min(earned, the ceilings from the number's health)
//
// `previous` is the count in the window just before the current one. The floor is what a number
// may always send, so a quiet or new number can start. `growthPercent` is how much a window may
// grow over the one before it. The √ term is headroom for ordinary scatter, so steady traffic is
// not blocked by chance. A send is refused (HTTP 429) when any window would go over its limit.
//
// Only messages with `type: "template"` are counted and limited. Free-form replies are not.

export interface WindowConfig {
  /** How much this window may exceed the previous one, in percent. */
  growthPercent: number;
  /** The count that is always allowed, whatever the previous window held. */
  floor: number;
}

export interface RateLimitConfig {
  /** Standard deviations of headroom added to the limit; 3 covers normal scatter. */
  headroomSigmas: number;
  minute: WindowConfig;
  hour: WindowConfig;
  day: WindowConfig;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  headroomSigmas: 3,
  minute: { growthPercent: 5, floor: 10 },
  hour: { growthPercent: 10, floor: 50 },
  // Meta's own starting limit for an unverified number is 250 customers a day; this is lower.
  day: { growthPercent: 20, floor: 100 },
};
