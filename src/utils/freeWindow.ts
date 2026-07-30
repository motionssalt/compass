// Free-window derivation for the duration-aware nudger.
//
// The existing "busy vs. free" concept in the bot is coarse: free =
// nothing currently in_progress and nothing scheduled for right now.
// For duration-aware nudging we need one more thing: how long is the
// free window before the next scheduled task fires?
//
// We stay deliberately lenient here — most tasks in this system are
// flexible (no time), and `scheduled_for` is often loose text like
// "morning" or "tonight" rather than an ISO datetime. When we can't
// parse a scheduled time we simply treat that task as not
// constraining the free window; the nudger falls back to an open-
// ended window and prefers tasks that comfortably fit inside a
// conservative default cap.

import type { Task } from '../types/task';

/**
 * Conservative upper bound on how long a "free window" can be
 * reported as. Prevents the nudger from casually suggesting a
 * 6-hour task on the grounds that "there's nothing scheduled all
 * day". 3 hours is a reasonable ADHD-friendly ceiling.
 */
export const FREE_WINDOW_SOFT_CAP_MINUTES = 3 * 60;

export interface FreeWindow {
  /** True when the user is currently busy (any task in_progress). */
  isBusy: boolean;
  /**
   * Minutes until the next scheduled task fires, or the soft cap
   * when nothing schedulable is on the horizon. Null when isBusy.
   */
  minutesAvailable: number | null;
  /**
   * Opaque signature of "what is currently constraining the window".
   * Used by the nudger to detect when the window has changed and a
   * fresh nudge is allowed. Stable across ticks that see the same
   * set of open+in-progress tasks.
   */
  signature: string;
}

/**
 * Try to parse a task's `scheduled_for` into "minutes from now".
 * Accepts:
 *   - ISO-8601 datetime strings (2026-07-30T18:00:00Z, etc.)
 *   - A plain HH:MM local-ish time — treated as today at that clock
 *     in the given timezone
 * Returns null when the value is missing or loose text ("morning",
 * "this week", "tonight") — those don't constrain the window.
 */
function scheduledMinutesFromNow(
  scheduled: string | null | undefined,
  now: Date,
  _timezone: string,
): number | null {
  if (!scheduled) return null;
  const trimmed = scheduled.trim();

  // Full ISO datetime (has 'T' and a date portion).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    const diff = ms - now.getTime();
    if (diff <= 0) return null; // Already past — doesn't constrain.
    return Math.round(diff / 60000);
  }

  // Bare HH:MM — interpret as "today at that clock in UTC-ish".
  // Timezone-perfect handling would need proper zone math; the
  // existing time helpers don't expose an offset calculation, so we
  // deliberately keep this rough. Overshoot rolls to tomorrow.
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (hhmm) {
    const hour = parseInt(hhmm[1], 10);
    const min = parseInt(hhmm[2], 10);
    if (hour > 23 || min > 59) return null;
    const target = new Date(now);
    target.setUTCHours(hour, min, 0, 0);
    let diff = target.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3600 * 1000;
    return Math.round(diff / 60000);
  }

  return null;
}

/**
 * A task is "constraining the window" when it is a hard-scheduled
 * item that will fire soon. In-progress tasks constrain immediately
 * (they make the user busy right now).
 */
function taskConstrainsWindow(t: Task, now: Date, tz: string): number | null {
  if (t.status === 'in_progress') return 0;
  if (t.status !== 'pending') return null;
  return scheduledMinutesFromNow(t.scheduled_for, now, tz);
}

/**
 * Compute the free window from the current set of open tasks.
 *
 * @param openTasks pending + in_progress rows for the user
 * @param now       the reference "now" (parameterised for testability)
 * @param timezone  IANA zone; only used for HH:MM parsing today
 */
export function computeFreeWindow(
  openTasks: Task[],
  now: Date,
  timezone: string,
): FreeWindow {
  // Anyone in_progress means the user is busy — no window at all.
  const inProgress = openTasks.filter((t) => t.status === 'in_progress');
  if (inProgress.length > 0) {
    return {
      isBusy: true,
      minutesAvailable: null,
      signature: `busy:${inProgress.map((t) => t.id).sort((a, b) => a - b).join(',')}`,
    };
  }

  // Nearest concretely-scheduled task determines the ceiling.
  let nearestMinutes: number | null = null;
  let nearestId: number | null = null;
  for (const t of openTasks) {
    const m = taskConstrainsWindow(t, now, timezone);
    if (m === null) continue;
    if (nearestMinutes === null || m < nearestMinutes) {
      nearestMinutes = m;
      nearestId = t.id;
    }
  }

  const capped = nearestMinutes === null
    ? FREE_WINDOW_SOFT_CAP_MINUTES
    : Math.min(nearestMinutes, FREE_WINDOW_SOFT_CAP_MINUTES);

  const sig = nearestId === null
    ? `free:open:${capped}`
    : `free:until#${nearestId}:${capped}`;

  return {
    isBusy: false,
    minutesAvailable: capped,
    signature: sig,
  };
}
