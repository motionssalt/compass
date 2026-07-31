// Shared domain types used by both the task and finance sides. Kept
// here (rather than re-exported from one feature module) so neither
// task.ts nor finance.ts has to import from the other.

/**
 * Recurrence rule for anything that repeats on a daily/weekly cadence
 * — used by both recurring tasks and recurring debts (e.g. monthly
 * rent modelled as a weekly rule on a fixed day, or a daily habit).
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly';
  // For weekly: lowercase 3-letter day codes: mon, tue, wed, thu, fri, sat, sun
  days?: string[];
}

/**
 * Lowercase 3-letter day-of-week code. The same shape RecurrenceRule
 * already uses for its `days` field, extracted so the scheduling-
 * constraint layer (below) can reuse it without a second parallel
 * definition drifting away over time.
 */
export type WeekdayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const WEEKDAY_CODES: readonly WeekdayCode[] = [
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
];

/**
 * Per-task scheduling constraint — a small, structured, optional
 * layer on top of the existing `scheduled_for` / `is_recurring` /
 * `recurrence_rule` fields. Any combination of the three sub-fields
 * is legal; each is independent of the others AND of whatever
 * recurrence rule (if any) the task already carries.
 *
 * Semantics: a task is "constraint-satisfied at instant T" iff every
 * PRESENT sub-constraint is satisfied at T (in the user's timezone).
 * An absent sub-constraint imposes no restriction. A null / undefined
 * SchedulingConstraint imposes no restriction at all — which is the
 * default state, matching every task written before this migration.
 *
 * Stored as a JSON string in tasks.schedule_constraint (see
 * migrations/0007_schedule_constraint.sql). Parse/validate/evaluate
 * lives in src/utils/scheduleConstraint.ts — nothing else should read
 * the raw JSON.
 */
export interface SchedulingConstraint {
  /**
   * Inclusive wall-clock date range in the user's timezone. Either
   * end may be omitted; both omitted is legal (though pointless) and
   * treated the same as an absent date_range. Dates are "YYYY-MM-DD".
   */
  date_range?: {
    start?: string;
    end?: string;
  };

  /**
   * Daily time-of-day window in the user's timezone, as 24-hour
   * "HH:MM" strings. Both ends are required when time_of_day is
   * present. Wraparound windows (start > end, e.g. 22:00..02:00) are
   * supported and mean "from start today through end tomorrow".
   *
   * Inclusive at the start and exclusive at the end, to match how
   * the free-window code already treats scheduled boundaries — a
   * task with time_of_day 08:00..09:00 is considered satisfied at
   * 08:00:00 but NOT at 09:00:00.
   */
  time_of_day?: {
    start: string;
    end: string;
  };

  /**
   * Applicable weekdays. Absent = all days. Non-empty subset of
   * WEEKDAY_CODES. Duplicate entries are tolerated on read (the
   * validator dedupes on write).
   */
  days_of_week?: WeekdayCode[];
}
