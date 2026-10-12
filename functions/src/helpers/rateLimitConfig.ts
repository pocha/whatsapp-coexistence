// Rate limits for template messages sent through the relay. Edit the values here to tune them
// for every number, or set a partial override on one number's record (phoneNumbers/{id}.rateLimits,
// written with the Admin SDK or the Firebase console, never by the customer) to treat it differently.
//
// How a window's limit is worked out (see rateLimiter.ts):
//
//   limit = max(floor, previous × (1 + growthPercent / 100) + headroomSigmas × √previous)
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
  /** Set to false to switch limiting off (the counters stop being written too). */
  enabled: boolean;
  /** Standard deviations of headroom added to the limit; 3 covers normal scatter. */
  headroomSigmas: number;
  minute: WindowConfig;
  hour: WindowConfig;
  day: WindowConfig;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  enabled: true,
  headroomSigmas: 3,
  minute: { growthPercent: 5, floor: 10 },
  hour: { growthPercent: 10, floor: 50 },
  // Meta's own starting limit for an unverified number is 250 customers a day; this is lower.
  day: { growthPercent: 20, floor: 100 },
};
