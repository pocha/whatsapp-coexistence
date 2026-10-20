// Rate limits for template messages sent through the relay, as pure functions with no Firebase or Node
// imports, so the Functions use them to decide and the dashboard uses the same code to show where a number
// stands. Edit DEFAULT_RATE_LIMITS to tune every number.
//
// How a window's limit is worked out:
//
//   earned = max(stored limit, floor, previous × (1 + growthPercent / 100) + headroomSigmas × √previous)
//   limit  = min(earned, the ceilings from the number's health)
//
// `previous` is the count in the window just before the current one. The floor is what a number may always
// send, so a quiet or new number can start. `growthPercent` is how much a window may grow over the one
// before it. The √ term is headroom for ordinary scatter, so steady traffic is not blocked by chance. A send
// is refused (HTTP 429) when any window would go over its limit. Only messages with `type: "template"` are
// counted and limited. Free-form replies are not.
//
// Two things can differ per number, both set with the Admin SDK or the Firebase console, never by the customer:
//   limits       (phoneNumbers/{id}.limits = { minute, hour, day }) what it has earned. Write higher values to
//                start an account that is moving over in good standing: they apply at once and then only grow.
//   rateLimits   a partial override of the values below, for example { "minute": { "floor": 40 } }, or
//                { "enabled": false } to switch limiting off for that number.

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

export type Unit = 'minute' | 'hour' | 'day';
export const UNITS: Unit[] = ['minute', 'hour', 'day'];

/** The per-number override: any part of the config, merged over the defaults. */
export type RateLimitOverride = Partial<Omit<RateLimitConfig, Unit>> & { [U in Unit]?: Partial<WindowConfig> };

export function effectiveConfig(override?: RateLimitOverride): RateLimitConfig {
  const base = DEFAULT_RATE_LIMITS;
  return {
    enabled: override?.enabled ?? base.enabled,
    headroomSigmas: override?.headroomSigmas ?? base.headroomSigmas,
    minute: { ...base.minute, ...override?.minute },
    hour: { ...base.hour, ...override?.hour },
    day: { ...base.day, ...override?.day },
  };
}

/** A number per window: what a number has earned, or a ceiling on it. */
export type Limits = Partial<Record<Unit, number>>;

/** Meta is not asked about a number again within this long of the last read. */
export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

// Fixed windows: minutes and hours on the clock, days in UTC.
const PERIOD_MS: Record<Unit, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/**
 * `current` and `previous` count what was accepted (and is what the limit is worked out from).
 * The `...Attempts` pair also counts requests that were refused, so a sender can see how hard it
 * hit the limit. Attempts never raise a limit: otherwise hammering the endpoint would buy growth.
 */
export interface WindowCount {
  current: number;
  previous: number;
  currentAttempts: number;
  previousAttempts: number;
}

/** What is stored on the number's record: a count pair per window, and when they were last written. */
export interface RateState {
  lastAt: number;
  minute: WindowCount;
  hour: WindowCount;
  day: WindowCount;
}

const empty = (): WindowCount => ({ current: 0, previous: 0, currentAttempts: 0, previousAttempts: 0 });

/**
 * Moves the stored counts forward to `now`: into the next window (current becomes previous), or
 * over a gap (both zero). Returns a new object, and is safe to call just to read.
 */
export function advance(state: RateState | undefined, now: number): RateState {
  const next: RateState = { lastAt: now, minute: empty(), hour: empty(), day: empty() };
  if (!state) return next;
  for (const unit of UNITS) {
    const steps = Math.floor(now / PERIOD_MS[unit]) - Math.floor(state.lastAt / PERIOD_MS[unit]);
    const was = state[unit] ?? empty();
    // Records written before attempts were kept have none; their attempts were all accepted.
    const attempts = { current: was.currentAttempts ?? was.current, previous: was.previousAttempts ?? was.previous };
    if (steps <= 0) {
      next[unit] = { current: was.current, previous: was.previous, currentAttempts: attempts.current, previousAttempts: attempts.previous };
    } else if (steps === 1) {
      next[unit] = { current: 0, previous: was.current, currentAttempts: 0, previousAttempts: attempts.current };
    }
    // More than one window ago: all zero.
  }
  return next;
}

/** When the window `now` falls in ends (milliseconds since the epoch). */
export function windowEnd(unit: Unit, now: number): number {
  return (Math.floor(now / PERIOD_MS[unit]) + 1) * PERIOD_MS[unit];
}

const grown = (previous: number, window: WindowConfig, sigmas: number) => Math.floor(previous * (1 + window.growthPercent / 100) + sigmas * Math.sqrt(previous));

/**
 * What a window allows: what the number has earned so far (the stored limit, the floor, or growth over the
 * previous window, whichever is most), under the ceiling. `earned` is what to store; it only ever rises.
 */
export function allowance(unit: Unit, previous: number, stored: Limits | undefined, caps: Limits, config: RateLimitConfig): { earned: number; limit: number } {
  const window = config[unit];
  const earned = Math.max(stored?.[unit] ?? 0, window.floor, grown(previous, window, config.headroomSigmas));
  return { earned, limit: Math.min(earned, caps[unit] ?? Infinity) };
}

export type Verdict =
  | { allowed: true; state: RateState; earned: Limits }
  | { allowed: false; state: RateState; earned: Limits; unit: Unit; limit: number; current: number; retryAfterSeconds: number };

/**
 * Decides whether one more template message may go, and returns the state to store. Every request
 * counts as an attempt in every window; only an accepted one raises the accepted count.
 */
export function reserve(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, config: RateLimitConfig, now: number): Verdict {
  const state = advance(stored, now);
  const earned: Limits = {};
  for (const unit of UNITS) state[unit].currentAttempts += 1;
  for (const unit of UNITS) earned[unit] = allowance(unit, state[unit].previous, limits, caps, config).earned;
  for (const unit of UNITS) {
    const limit = Math.min(earned[unit]!, caps[unit] ?? Infinity);
    if (state[unit].current + 1 > limit) {
      return {
        allowed: false,
        state,
        earned,
        unit,
        limit,
        current: state[unit].current,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEnd(unit, now) - now) / 1000)),
      };
    }
  }
  for (const unit of UNITS) state[unit].current += 1;
  return { allowed: true, state, earned };
}

/** Where a number stands right now, for display: each window's count, previous count and limit. */
export function view(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, config: RateLimitConfig, now: number) {
  const state = advance(stored, now);
  return Object.fromEntries(
    UNITS.map((unit) => [
      unit,
      { ...state[unit], limit: allowance(unit, state[unit].previous, limits, caps, config).limit },
    ]),
  ) as Record<Unit, WindowCount & { limit: number }>;
}

/** What a sender needs to pace itself: per window, what went through, what is left, and when it resets. */
export interface WindowLimits {
  accepted: number;
  attempted: number;
  previousAccepted: number;
  limit: number;
  remaining: number;
  /** Milliseconds since the epoch. */
  resetsAt: number;
}

export function limitsView(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, config: RateLimitConfig, now: number): Record<Unit, WindowLimits> {
  const windows = view(stored, limits, caps, config, now);
  return Object.fromEntries(
    UNITS.map((unit) => {
      const w = windows[unit];
      return [
        unit,
        {
          accepted: w.current,
          attempted: w.currentAttempts,
          previousAccepted: w.previous,
          limit: w.limit,
          remaining: Math.max(0, w.limit - w.current),
          resetsAt: windowEnd(unit, now),
        },
      ];
    }),
  ) as Record<Unit, WindowLimits>;
}
