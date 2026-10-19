// The rate-limiting logic: pure functions with no Firebase or Node imports, so the Functions use
// them to decide and the dashboard uses the same code to show where a number stands. The values
// live in rateLimitConfig.ts.
import { DEFAULT_RATE_LIMITS, type RateLimitConfig, type WindowConfig } from './rateLimitConfig';

export type Unit = 'minute' | 'hour' | 'day';
export const UNITS: Unit[] = ['minute', 'hour', 'day'];
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

export function limitFor(previous: number, window: WindowConfig, headroomSigmas: number): number {
  const grown = Math.floor(Math.max(window.floor, previous * (1 + window.growthPercent / 100) + headroomSigmas * Math.sqrt(previous)));
  return window.max === undefined ? grown : Math.min(grown, window.max);
}

export type Verdict =
  | { allowed: true; state: RateState }
  | { allowed: false; state: RateState; unit: Unit; limit: number; current: number; retryAfterSeconds: number };

/**
 * Decides whether one more template message may go, and returns the state to store. Every request
 * counts as an attempt in every window; only an accepted one raises the accepted count.
 */
export function reserve(stored: RateState | undefined, config: RateLimitConfig, now: number): Verdict {
  const state = advance(stored, now);
  for (const unit of UNITS) state[unit].currentAttempts += 1;
  for (const unit of UNITS) {
    const limit = limitFor(state[unit].previous, config[unit], config.headroomSigmas);
    if (state[unit].current + 1 > limit) {
      return {
        allowed: false,
        state,
        unit,
        limit,
        current: state[unit].current,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEnd(unit, now) - now) / 1000)),
      };
    }
  }
  for (const unit of UNITS) state[unit].current += 1;
  return { allowed: true, state };
}

/** Where a number stands right now, for display: each window's count, previous count and limit. */
export function view(stored: RateState | undefined, config: RateLimitConfig, now: number) {
  const state = advance(stored, now);
  return Object.fromEntries(
    UNITS.map((unit) => [
      unit,
      { ...state[unit], limit: limitFor(state[unit].previous, config[unit], config.headroomSigmas) },
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

export function limitsView(stored: RateState | undefined, config: RateLimitConfig, now: number): Record<Unit, WindowLimits> {
  const windows = view(stored, config, now);
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
