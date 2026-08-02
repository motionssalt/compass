// Deadline-aware urgency ranking (tone + ordering ONLY).
//
// Motionsalt Compass carries two related-but-separate signals of "how
// urgent is this task?":
//
//   1. The stored letter-grade priority (A+..E-). That's the user's
//      / AI's expressed sense of importance. It changes only when
//      someone explicitly edits it via a write path.
//
//   2. The task's deadline proximity — derived from `scheduled_for`
//      (when it parses to a concrete instant) OR the end of its
//      `schedule_constraint.date_range` (which the AI and the
//      direct-command path both write for "must be done by X"
//      windows). As the deadline approaches, the task becomes more
//      urgent regardless of what its letter grade says.
//
// This module derives an OVERLAY urgency value from the deadline
// only. It never mutates a stored priority. Callers combine the
// overlay with the letter-grade sort — the nudge scorer uses it as
// a positive component, the systemPrompt uses the categorical form
// to tint how it talks about a task, and directTasks uses it to
// tag the render.
//
// Pure: no D1, no network, no clock reads — the caller passes `now`.

import type { Task } from '../types/task';
import { safeParseStoredConstraint } from './scheduleConstraint';

// ---------------------------------------------------------------
// Deadline extraction
// ---------------------------------------------------------------

/**
 * Best-effort concrete deadline for a task, as an epoch-ms number.
 * Returns null when the task has no parseable deadline — most tasks
 * in this system are flexible / loose-text, and those are simply
 * treated as "no deadline pressure".
 *
 * Sources, in order of preference (a more specific pointer beats a
 * looser one):
 *   1. `scheduled_for` when it parses as an ISO datetime.
 *   2. `schedule_constraint.date_range.end` — the last day the
 *      constraint window admits the task. Treated as end-of-day in
 *      the caller's timezone; from a plain epoch-ms angle we just
 *      pin it to 23:59:59 UTC of that date, which is close enough
 *      for the "hours-until-deadline" bucketing below (a per-zone
 *      exact instant would require the user's tz here and buy us
 *      nothing at this bucket granularity).
 *
 * Loose free-text scheduled_for ("morning", "tonight", "this week")
 * doesn't set a deadline. Tasks with only a recurrence rule and no
 * hard end date don't either — those repeat indefinitely.
 */
export function taskDeadlineMs(task: Task): number | null {
  const sched = task.scheduled_for?.trim();
  if (sched && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(sched)) {
    const ms = Date.parse(sched);
    if (Number.isFinite(ms)) return ms;
  }
  const constraint = safeParseStoredConstraint(task.schedule_constraint);
  const end = constraint?.date_range?.end;
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    const ms = Date.parse(`${end}T23:59:59Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// ---------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------

/**
 * Ordered coarse buckets the rest of the codebase can key off. Order
 * matters — the enum values are sorted from most urgent (overdue) to
 * least urgent (far / none).
 */
export type UrgencyBucket =
  | 'overdue'    // deadline is already in the past
  | 'imminent'   // <= 2 hours away
  | 'today'      // <= 24 hours away
  | 'soon'       // <= 3 days away
  | 'this_week'  // <= 7 days away
  | 'far'        // > 7 days away
  | 'none';      // no parseable deadline

/**
 * Classify a task's deadline pressure at instant `now`. Loose /
 * missing deadlines all land in 'none'.
 */
export function urgencyBucket(task: Task, now: Date): UrgencyBucket {
  const deadline = taskDeadlineMs(task);
  if (deadline === null) return 'none';
  const diffMs = deadline - now.getTime();
  if (diffMs <= 0) return 'overdue';
  const hours = diffMs / (60 * 60 * 1000);
  if (hours <= 2) return 'imminent';
  if (hours <= 24) return 'today';
  if (hours <= 24 * 3) return 'soon';
  if (hours <= 24 * 7) return 'this_week';
  return 'far';
}

/**
 * Numeric urgency BOOST (0..100+) driven purely by deadline
 * proximity. Meant to be added to a task's ranking score without
 * touching the stored priority letter. A task with no parseable
 * deadline scores 0 — same as it would have before the deadline
 * layer existed, so this addition never demotes a well-set letter
 * grade for a genuinely flexible task.
 *
 * Rough calibration:
 *   overdue   -> 120  (heavier than any other bucket so overdue
 *                       always outranks a same-priority "next week")
 *   imminent  ->  80
 *   today     ->  55
 *   soon      ->  30
 *   this_week ->  12
 *   far       ->   3
 *   none      ->   0
 *
 * Numbers are chosen relative to nudgeScoring.ts' existing scale
 * (priorityScore is 0..100 across the 15-grade letter range); the
 * deadline overlay sits ALONGSIDE that, never as a replacement.
 */
export function urgencyBoost(task: Task, now: Date): number {
  const bucket = urgencyBucket(task, now);
  switch (bucket) {
    case 'overdue':   return 120;
    case 'imminent':  return 80;
    case 'today':     return 55;
    case 'soon':      return 30;
    case 'this_week': return 12;
    case 'far':       return 3;
    case 'none':      return 0;
  }
}

/**
 * Short, human-readable label for the systemPrompt / task-line
 * decorators. Returns null for `'none'` / `'far'` so nothing gets
 * appended when the deadline doesn't yet warrant attention.
 * The rendered string is intentionally compact — it sits inside an
 * already-crowded per-task line.
 */
export function urgencyLabel(task: Task, now: Date): string | null {
  const bucket = urgencyBucket(task, now);
  const deadline = taskDeadlineMs(task);
  if (deadline === null) return null;
  const diffMs = deadline - now.getTime();
  const absHours = Math.abs(diffMs) / (60 * 60 * 1000);
  const hoursStr = absHours < 1
    ? `${Math.max(1, Math.round(absHours * 60))}min`
    : absHours < 48
      ? `${Math.round(absHours)}h`
      : `${Math.round(absHours / 24)}d`;
  switch (bucket) {
    case 'overdue':   return `overdue by ${hoursStr}`;
    case 'imminent':  return `in ${hoursStr}`;
    case 'today':     return `in ${hoursStr}`;
    case 'soon':      return `in ${hoursStr}`;
    case 'this_week': return `in ${hoursStr}`;
    // 'far' and 'none' don't warrant a tag on the render — the
    // letter-grade priority is doing enough work on its own out
    // there.
    case 'far':       return null;
    case 'none':      return null;
  }
}

/**
 * Comparator over two tasks by (urgency bucket, then deadline
 * proximity). Lower return value = more urgent (matches the "lower
 * priority int is more important" convention already used by
 * comparePriorityInt). Used by callers that want deadline-first
 * ordering; letter-grade tie-breaks stay a separate concern of
 * the caller.
 */
const BUCKET_ORDER: Record<UrgencyBucket, number> = {
  overdue:   0,
  imminent:  1,
  today:     2,
  soon:      3,
  this_week: 4,
  far:       5,
  none:      6,
};

export function compareByUrgency(a: Task, b: Task, now: Date): number {
  const ba = urgencyBucket(a, now);
  const bb = urgencyBucket(b, now);
  const diff = BUCKET_ORDER[ba] - BUCKET_ORDER[bb];
  if (diff !== 0) return diff;
  const da = taskDeadlineMs(a);
  const db = taskDeadlineMs(b);
  if (da !== null && db !== null) return da - db;
  if (da !== null) return -1;
  if (db !== null) return 1;
  return 0;
}
