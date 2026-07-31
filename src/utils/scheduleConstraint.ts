// Per-task scheduling-constraint parsing, validation, and evaluation.
//
// The shape lives in ../types/shared.ts (SchedulingConstraint). This
// module is the ONE place that reads or writes the raw JSON stored in
// tasks.schedule_constraint — everything else in the codebase goes
// through parse / validate / stringify / isConstraintSatisfied so a
// bad blob can never leak into the DB and a corrupt row can never
// crash the nudger.
//
// The helpers here are pure (no D1, no network). Timezone handling
// reuses ../utils/time.ts so we stay consistent with the rest of the
// codebase's IANA-based approach — no separate tz database, no
// duplicated offset math.

import type { SchedulingConstraint, WeekdayCode } from '../types/shared';
import { WEEKDAY_CODES } from '../types/shared';
import type { RecurrenceRule } from '../types/shared';
import { localDateParts, localWeekday, localClockString } from './time';

// ---------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------

/** Result envelope for parse/validate — mirrors the style used elsewhere. */
export type ConstraintParse =
  | { ok: true; constraint: SchedulingConstraint | null }
  | { ok: false; error: string };

/**
 * Parse whatever came off the wire (a JSON string from the DB, a
 * plain object from the AI tools / direct handlers, or null) into a
 * validated SchedulingConstraint. Returns `constraint: null` for
 * every "no constraint" input (null, undefined, empty string,
 * literal empty object) — those are all equivalent to "no
 * constraint" and stored as SQL NULL.
 *
 * On any invalid shape we return an error rather than throwing, so
 * callers can surface it to the user (parseTaskLine-style) or the
 * AI (tool response { ok: false, error }) uniformly.
 */
export function parseScheduleConstraint(
  input: string | Record<string, unknown> | null | undefined,
): ConstraintParse {
  if (input === null || input === undefined) return { ok: true, constraint: null };

  let obj: Record<string, unknown>;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, constraint: null };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null) return { ok: true, constraint: null };
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'schedule_constraint must be a JSON object' };
      }
      obj = parsed as Record<string, unknown>;
    } catch (e) {
      return {
        ok: false,
        error: `schedule_constraint is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    obj = input;
  }

  const c: SchedulingConstraint = {};

  // --- date_range ---
  if (obj.date_range !== undefined && obj.date_range !== null) {
    const raw = obj.date_range;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'date_range must be an object' };
    }
    const dr = raw as Record<string, unknown>;
    const dateRange: { start?: string; end?: string } = {};
    if (dr.start !== undefined && dr.start !== null) {
      if (typeof dr.start !== 'string' || !isIsoDate(dr.start)) {
        return { ok: false, error: `date_range.start must be YYYY-MM-DD, got "${String(dr.start)}"` };
      }
      dateRange.start = dr.start;
    }
    if (dr.end !== undefined && dr.end !== null) {
      if (typeof dr.end !== 'string' || !isIsoDate(dr.end)) {
        return { ok: false, error: `date_range.end must be YYYY-MM-DD, got "${String(dr.end)}"` };
      }
      dateRange.end = dr.end;
    }
    if (dateRange.start && dateRange.end && dateRange.start > dateRange.end) {
      return { ok: false, error: `date_range.start (${dateRange.start}) is after date_range.end (${dateRange.end})` };
    }
    // Skip an empty date_range — semantically it's "no range".
    if (dateRange.start !== undefined || dateRange.end !== undefined) {
      c.date_range = dateRange;
    }
  }

  // --- time_of_day ---
  if (obj.time_of_day !== undefined && obj.time_of_day !== null) {
    const raw = obj.time_of_day;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'time_of_day must be an object' };
    }
    const tw = raw as Record<string, unknown>;
    // Both ends required when time_of_day is present — a one-sided
    // daily window is ambiguous (does "after 08:00" mean until
    // midnight? until 08:00 tomorrow?), so we refuse it up front.
    if (typeof tw.start !== 'string' || !isHhmm(tw.start)) {
      return { ok: false, error: `time_of_day.start must be HH:MM, got "${String(tw.start)}"` };
    }
    if (typeof tw.end !== 'string' || !isHhmm(tw.end)) {
      return { ok: false, error: `time_of_day.end must be HH:MM, got "${String(tw.end)}"` };
    }
    if (tw.start === tw.end) {
      return { ok: false, error: 'time_of_day.start and time_of_day.end must differ' };
    }
    c.time_of_day = { start: tw.start, end: tw.end };
  }

  // --- days_of_week ---
  if (obj.days_of_week !== undefined && obj.days_of_week !== null) {
    if (!Array.isArray(obj.days_of_week)) {
      return { ok: false, error: 'days_of_week must be an array of weekday codes' };
    }
    const seen = new Set<WeekdayCode>();
    for (const raw of obj.days_of_week) {
      if (typeof raw !== 'string') {
        return { ok: false, error: `days_of_week entries must be strings, got ${typeof raw}` };
      }
      const code = raw.trim().toLowerCase();
      if (!(WEEKDAY_CODES as readonly string[]).includes(code)) {
        return { ok: false, error: `days_of_week: "${raw}" is not a valid weekday code (mon..sun)` };
      }
      seen.add(code as WeekdayCode);
    }
    if (seen.size === 0) {
      // Empty array === no restriction; drop it rather than storing [].
    } else if (seen.size === WEEKDAY_CODES.length) {
      // All seven days === no restriction; drop it too.
    } else {
      // Preserve canonical mon..sun order.
      c.days_of_week = WEEKDAY_CODES.filter((d) => seen.has(d));
    }
  }

  // A constraint that ended up entirely empty is equivalent to no
  // constraint at all — store it as null so we don't clutter rows
  // with `{}`.
  if (
    c.date_range === undefined
    && c.time_of_day === undefined
    && c.days_of_week === undefined
  ) {
    return { ok: true, constraint: null };
  }

  return { ok: true, constraint: c };
}

/**
 * JSON-serialise a constraint for storage. Null / no-op constraints
 * round-trip to null so a `SET schedule_constraint = ?` with the
 * result clears the column cleanly.
 */
export function stringifyScheduleConstraint(
  c: SchedulingConstraint | null | undefined,
): string | null {
  if (!c) return null;
  if (
    c.date_range === undefined
    && c.time_of_day === undefined
    && c.days_of_week === undefined
  ) {
    return null;
  }
  return JSON.stringify(c);
}

/**
 * Read a stored JSON blob back into a SchedulingConstraint. On a
 * corrupt row we log-fail-open: return null (no restriction) rather
 * than crash the nudger. A malformed blob is a bug worth surfacing
 * elsewhere, but never worth swallowing an entire cron tick over.
 */
export function safeParseStoredConstraint(
  stored: string | null | undefined,
): SchedulingConstraint | null {
  if (!stored) return null;
  const res = parseScheduleConstraint(stored);
  if (!res.ok) return null;
  return res.constraint;
}

// ---------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------

/**
 * Is the constraint satisfied AT `now`, in the user's timezone?
 *
 * A null constraint is always satisfied — that's the whole point of
 * the field being optional. A partially-populated constraint is
 * satisfied when every PRESENT sub-constraint is satisfied; absent
 * sub-constraints impose no restriction.
 */
export function isConstraintSatisfied(
  constraint: SchedulingConstraint | null | undefined,
  now: Date,
  timezone: string,
): boolean {
  if (!constraint) return true;

  const localDate = formatLocalDate(now, timezone);
  const localTime = localClockString(now, timezone); // "HH:MM"
  const weekday = localWeekday(now, timezone) as WeekdayCode;

  if (constraint.date_range) {
    const { start, end } = constraint.date_range;
    if (start && localDate < start) return false;
    if (end && localDate > end) return false;
  }

  if (constraint.days_of_week && constraint.days_of_week.length > 0) {
    if (!constraint.days_of_week.includes(weekday)) return false;
  }

  if (constraint.time_of_day) {
    if (!isWithinDailyWindow(localTime, constraint.time_of_day.start, constraint.time_of_day.end)) {
      return false;
    }
  }

  return true;
}

/**
 * Has the constraint's window CLOSED for the current cycle at `now`?
 *
 * A "closed" window is what the nudger uses to decide "this cycle
 * was missed": the constraint used to admit the current cycle, but
 * the last moment at which it could have been satisfied has passed.
 * Absent-constraint means never closed (nothing to miss).
 *
 *   * date_range.end past                     -> closed for good
 *   * days_of_week without today AND time_of_day already past today
 *       (or no time_of_day and it's past midnight)          -> closed for today
 *   * time_of_day whose end is past today                    -> closed for today
 *
 * The "cycle" concept only becomes meaningful in combination with
 * cycleKeyForNow() below — this function just answers "is the
 * window shut RIGHT NOW?".
 */
export function isConstraintWindowClosedForCycle(
  constraint: SchedulingConstraint | null | undefined,
  now: Date,
  timezone: string,
): boolean {
  if (!constraint) return false;
  // Currently open -> definitely not closed.
  if (isConstraintSatisfied(constraint, now, timezone)) return false;

  const localDate = formatLocalDate(now, timezone);
  const localTime = localClockString(now, timezone);
  const weekday = localWeekday(now, timezone) as WeekdayCode;

  // Past the hard date_range.end -> the whole thing is done.
  if (constraint.date_range?.end && localDate > constraint.date_range.end) {
    return true;
  }
  // Before the date_range.start -> the window hasn't OPENED yet, so
  // it isn't "closed for this cycle" either.
  if (constraint.date_range?.start && localDate < constraint.date_range.start) {
    return false;
  }

  const todayIsInDayList =
    !constraint.days_of_week
    || constraint.days_of_week.length === 0
    || constraint.days_of_week.includes(weekday);

  if (constraint.time_of_day) {
    const { start, end } = constraint.time_of_day;
    // Wraparound windows (22:00..02:00) don't cleanly "close" mid-
    // day — a task rejected at 15:00 might be admitted again at
    // 22:00 today. Only treat as closed if today isn't in the day
    // list at all AND we're already past midnight-ish; safest is to
    // report not-closed for wraparound and let cycle-key rotation
    // do the work.
    if (start < end) {
      // Non-wraparound: the window closes at `end` today.
      if (todayIsInDayList && localTime >= end) return true;
      if (!todayIsInDayList) return true;
      return false;
    }
    // Wraparound path.
    if (!todayIsInDayList && (localTime >= end && localTime < start)) return true;
    return false;
  }

  // No time_of_day: the "window" is the whole day, closed at
  // midnight. If today isn't in the day list, we're already outside
  // this cycle's window.
  if (!todayIsInDayList) return true;
  return false;
}

// ---------------------------------------------------------------
// Cycle keys — used by the missed-cycle bookkeeping
// ---------------------------------------------------------------

/**
 * Compute the opaque "current cycle key" for a recurring task at
 * `now`, based on its recurrence rule. This is what the nudger
 * stamps into tasks.missed_cycle_key when it observes a window
 * closing uncompleted, and what it compares against next tick to
 * decide "same cycle" vs "new cycle".
 *
 * Shape:
 *   daily rule   -> "daily:YYYY-MM-DD"
 *   weekly rule  -> "weekly:YYYY-Www"   (ISO week; wraps naturally
 *                                        across month boundaries)
 *   no rule      -> null
 *
 * Weekly keying deliberately uses the ISO week rather than the
 * individual weekday: a task set to fire mon/wed is ONE weekly cycle
 * across both days — a missed monday shouldn't be re-flagged when
 * wednesday comes around. That behaviour matches how a human would
 * think of "the week's Mon-and-Wed check-in".
 */
export function cycleKeyForNow(
  rule: RecurrenceRule | null | undefined,
  now: Date,
  timezone: string,
): string | null {
  if (!rule) return null;
  if (rule.freq === 'daily') {
    return `daily:${formatLocalDate(now, timezone)}`;
  }
  if (rule.freq === 'weekly') {
    return `weekly:${isoWeekKey(now, timezone)}`;
  }
  return null;
}

// ---------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Cheap sanity: month 01..12, day 01..31. We don't bother with
  // per-month day counts — a real Date roundtrip would catch that
  // but at the cost of a Date allocation per parse. Leap-year hair-
  // splitting is not worth the ceremony here.
  const m = parseInt(s.slice(5, 7), 10);
  const d = parseInt(s.slice(8, 10), 10);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function isHhmm(s: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
}

function formatLocalDate(date: Date, timezone: string): string {
  const { year, month, day } = localDateParts(date, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Is `t` (HH:MM) inside the daily window [start, end)? Supports
 * wraparound windows where start > end (e.g. 22:00..02:00 means
 * 22:00..24:00 today OR 00:00..02:00).
 */
function isWithinDailyWindow(t: string, start: string, end: string): boolean {
  if (start < end) return t >= start && t < end;
  // Wraparound.
  return t >= start || t < end;
}

/**
 * ISO week key "YYYY-Www" for the given instant in the user's zone.
 * Kept internal — nobody outside cycleKeyForNow needs it, and doing
 * it inline here means we don't have to add another export to
 * utils/time.ts for a single caller.
 */
function isoWeekKey(now: Date, timezone: string): string {
  const { year, month, day } = localDateParts(now, timezone);
  // Compute ISO week from the local calendar date. Treat the local
  // wall date as a UTC Date to avoid the host timezone bending the
  // weekday indexing (Cloudflare Workers run in UTC anyway, but the
  // computation is defensively zone-neutral).
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayNum = utcDate.getUTCDay() || 7; // Sun=0 -> 7, Mon=1..Sat=6
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${utcDate.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
