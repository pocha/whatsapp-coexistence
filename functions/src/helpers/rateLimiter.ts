// The rate-limiting logic: pure functions with no Firebase or Node imports, so the Functions use
// them to decide and the dashboard uses the same code to show where a number stands. The values
// live in rateLimitConfig.ts.
import { DEFAULT_RATE_LIMITS, type WindowConfig } from './rateLimitConfig';

export type Unit = 'minute' | 'hour' | 'day';
export const UNITS: Unit[] = ['minute', 'hour', 'day'];

/** A number per window: what a number has earned, or a ceiling on it. */
export type Limits = Partial<Record<Unit, number>>;
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
export function allowance(unit: Unit, previous: number, stored: Limits | undefined, caps: Limits): { earned: number; limit: number } {
  const window = DEFAULT_RATE_LIMITS[unit];
  const earned = Math.max(stored?.[unit] ?? 0, window.floor, grown(previous, window, DEFAULT_RATE_LIMITS.headroomSigmas));
  return { earned, limit: Math.min(earned, caps[unit] ?? Infinity) };
}

export type Verdict =
  | { allowed: true; state: RateState; earned: Limits }
  | { allowed: false; state: RateState; earned: Limits; unit: Unit; limit: number; current: number; retryAfterSeconds: number };

/**
 * Decides whether one more template message may go, and returns the state to store. Every request
 * counts as an attempt in every window; only an accepted one raises the accepted count.
 */
export function reserve(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, now: number): Verdict {
  const state = advance(stored, now);
  const earned: Limits = {};
  for (const unit of UNITS) state[unit].currentAttempts += 1;
  for (const unit of UNITS) earned[unit] = allowance(unit, state[unit].previous, limits, caps).earned;
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
export function view(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, now: number) {
  const state = advance(stored, now);
  return Object.fromEntries(
    UNITS.map((unit) => [
      unit,
      { ...state[unit], limit: allowance(unit, state[unit].previous, limits, caps).limit },
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

export function limitsView(stored: RateState | undefined, limits: Limits | undefined, caps: Limits, now: number): Record<Unit, WindowLimits> {
  const windows = view(stored, limits, caps, now);
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
