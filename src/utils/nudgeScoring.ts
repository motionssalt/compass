// Scoring flexible tasks against a free window.
//
// Inputs:
//   - a computed FreeWindow (minutesAvailable)
//   - the user's open flexible task set (pending, non-recurring or
//     recurring-but-not-time-anchored; we treat any task without a
//     concrete scheduled_for as flexible)
//
// Output: the single best-fit task to nudge about, or null when
// nothing meaningfully fits.
//
// Scoring axes (higher = better):
//   1. Fits inside the window comfortably.
//   2. Higher letter-grade priority (A+ beats E-).
//   3. Older-waiting tasks beat freshly-created ones (helps stale
//      items surface).
//   4. Fairness penalty for tasks nudged recently.
//
// This module is pure — no D1, no network. It gets a snapshot of
// tasks + the current time, returns a decision.

import type { Task } from '../types/task';
import type { FreeWindow } from './freeWindow';
import {
  comparePriorityInt,
  DEFAULT_PRIORITY_INT,
  MAX_PRIORITY_INT,
} from './priority';

/** Tasks whose duration exceeds the window by more than this are unfit. */
const OVERRUN_TOLERANCE_MINUTES = 5;

/** Tasks nudged within this many minutes are heavily penalised. */
const RECENT_NUDGE_WINDOW_MINUTES = 6 * 60;

/**
 * A task is "flexible" (eligible for free-window nudging) when it is
 * open and either has no scheduled_for at all, or its scheduled_for
 * is loose free-text rather than a hard datetime. We keep the
 * detection simple: a value starting with "YYYY-MM-DD" is treated as
 * hard, everything else as flexible.
 */
export function isFlexibleTask(t: Task): boolean {
  if (t.status !== 'pending') return false;
  if (!t.scheduled_for) return true;
  const s = t.scheduled_for.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return true;
}

export interface ScoredTask {
  task: Task;
  score: number;
  fits: boolean;
  reason: string;
}

/**
 * Score a single task against a free window. Not exported as
 * primary API — pickNudgeTask does the batching + sort — but kept
 * standalone for testability.
 */
export function scoreTaskForWindow(
  task: Task,
  window: FreeWindow,
  now: Date,
): ScoredTask {
  const available = window.minutesAvailable ?? 0;
  const est = task.time_estimate_minutes ?? null;

  // Fit check. A task with no duration is treated as "fits, but
  // slightly less confident" — we don't know how long it takes.
  let fits = true;
  let fitScore = 0;
  if (est !== null) {
    const overrun = est - available;
    if (overrun > OVERRUN_TOLERANCE_MINUTES) {
      fits = false;
    } else {
      // Bonus for a task that comfortably fits with slack left over.
      const slack = Math.max(0, available - est);
      fitScore = 40 + Math.min(30, slack / Math.max(available, 1) * 30);
    }
  } else {
    // Unknown duration — mild penalty, still eligible.
    fitScore = 20;
  }

  // Priority: A+ (int=1) scores highest, E- (int=15) lowest.
  // Scale 100 down to 0 across the 15-step letter grade range.
  const prInt = task.priority ?? DEFAULT_PRIORITY_INT;
  const priorityScore = 100 - ((prInt - 1) / (MAX_PRIORITY_INT - 1)) * 100;

  // Age: older-waiting tasks nudge up. Cap at 14 days so nothing
  // silently dominates forever.
  const created = Date.parse(task.created_at);
  const ageDays = Number.isFinite(created)
    ? Math.min(14, Math.max(0, (now.getTime() - created) / (24 * 3600 * 1000)))
    : 0;
  const ageScore = (ageDays / 14) * 25;

  // Fairness: strongly demote a task we just nudged.
  let fairnessPenalty = 0;
  if (task.last_nudged_at) {
    const nudged = Date.parse(task.last_nudged_at);
    if (Number.isFinite(nudged)) {
      const minutesSince = (now.getTime() - nudged) / 60000;
      if (minutesSince < RECENT_NUDGE_WINDOW_MINUTES) {
        // Linear from -80 (just nudged) to 0 (window edge).
        fairnessPenalty = -80 * (1 - minutesSince / RECENT_NUDGE_WINDOW_MINUTES);
      }
    }
  }

  const score = fits
    ? fitScore + priorityScore + ageScore + fairnessPenalty
    : -1000; // Effectively excluded.

  const reason = fits
    ? `pr=${prInt} age=${ageDays.toFixed(1)}d fit=${fitScore.toFixed(0)} fair=${fairnessPenalty.toFixed(0)}`
    : `overruns window (est=${est}min > ${available}min)`;

  return { task, score, fits, reason };
}

/**
 * Pick the single best flexible task to nudge about, or null when
 * nothing suitable is open. Ties on score break by lower priority
 * integer (more important first), then by lower id (older first).
 */
export function pickNudgeTask(
  openTasks: Task[],
  window: FreeWindow,
  now: Date,
): ScoredTask | null {
  if (window.isBusy || window.minutesAvailable === null) return null;

  const flexible = openTasks.filter(isFlexibleTask);
  if (flexible.length === 0) return null;

  const scored = flexible
    .map((t) => scoreTaskForWindow(t, window, now))
    .filter((s) => s.fits);
  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const p = comparePriorityInt(a.task.priority, b.task.priority);
    if (p !== 0) return p;
    return a.task.id - b.task.id;
  });

  return scored[0];
}
