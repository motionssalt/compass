// Duration-aware free-time nudger.
//
// Runs on its OWN, higher-frequency cron trigger (separate from the
// existing daily reset in cron.ts). Pure D1 + Telegram — no Gemini,
// no runAgent, no quota burn.
//
// Per user, per tick:
//   1. Load open tasks.
//   2. Run the missed-cycle housekeeping pass — stamp
//      missed_cycle_key on recurring tasks whose constraint window
//      just closed uncompleted, and clear stale keys whose cycle has
//      rolled over. This runs regardless of whether we end up
//      nudging so a rare all-busy stretch never lets a missed cycle
//      go unrecorded.
//   3. Compute the current free window (see utils/freeWindow.ts).
//   4. If busy, skip.
//   5. If the window's signature matches the last-nudged signature,
//      skip (we already nudged for this window).
//   6. Score flexible + currently-constraint-eligible tasks
//      (utils/nudgeScoring.ts), pick the best fit, record the nudge,
//      and send a Telegram message.
//
// One nudge per free window is the entire contract — the fairness
// check on window signature enforces it.

import type { Env } from '../types/env';
import type { Task } from '../types/task';
import type { RecurrenceRule } from '../types/shared';
import {
  listOpenTasks,
  markMissedCycle,
  clearMissedCycleIfKeyMatches,
} from '../db/tasks';
import {
  listUsersForNudging, getNudgeState, recordNudge,
} from '../db/nudge';
import { computeFreeWindow } from '../utils/freeWindow';
import { pickNudgeTask } from '../utils/nudgeScoring';
import {
  safeParseStoredConstraint,
  isConstraintWindowClosedForCycle,
  cycleKeyForNow,
} from '../utils/scheduleConstraint';
import { priorityIntToLetter, DEFAULT_PRIORITY_INT } from '../utils/priority';
import { urgencyLabel } from '../utils/urgency';
import { sendMessage } from '../services/telegram';
import { log } from '../utils/logger';

export async function handleNudgeCron(env: Env): Promise<void> {
  const defaultTz = env.DEFAULT_TIMEZONE || 'UTC';
  const users = await listUsersForNudging(env.DB);

  let considered = 0;
  let nudged = 0;
  let skippedBusy = 0;
  let skippedSameWindow = 0;
  let skippedNoFit = 0;
  let skippedNoChat = 0;
  let missedStamped = 0;
  let missedCleared = 0;

  const now = new Date();

  for (const u of users) {
    considered++;
    try {
      const tz = u.timezone || defaultTz;
      const state = await getNudgeState(env.DB, u.user_id);

      // No known chat_id means we've never seen this user speak
      // (unlikely — they must have an inbound message to be in
      // `users`) or they only spoke before rememberChatId shipped.
      // Either way, we can't deliver.
      if (!state || !state.chat_id) {
        skippedNoChat++;
        continue;
      }

      const openTasks = await listOpenTasks(env.DB, u.user_id);

      // Missed-cycle housekeeping runs BEFORE the busy/signature
      // gates: whether or not we deliver a nudge this tick, the
      // recurring-task cycle bookkeeping needs to stay current.
      const bookkeeping = await reconcileMissedCycles(env, u.user_id, openTasks, now, tz);
      missedStamped += bookkeeping.stamped;
      missedCleared += bookkeeping.cleared;

      const window = computeFreeWindow(openTasks, now, tz);

      if (window.isBusy) {
        skippedBusy++;
        continue;
      }

      if (state.last_window_signature === window.signature) {
        // Same window as last time — we already nudged (or already
        // tried and there was nothing to say). Either way, hold off.
        skippedSameWindow++;
        continue;
      }

      const pick = pickNudgeTask(openTasks, window, now, tz);
      if (!pick) {
        // Still stamp the signature so we don't retry every tick.
        await recordNudge(env.DB, u.user_id, window.signature, 0);
        skippedNoFit++;
        continue;
      }

      const message = formatNudgeMessage(pick.task, window.minutesAvailable!, now);
      await sendMessage(env, state.chat_id, message);
      await recordNudge(env.DB, u.user_id, window.signature, pick.task.id);
      nudged++;
    } catch (err) {
      log.warn('nudge_user_failed', {
        user_id: u.user_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('cron_nudge_tick', {
    considered,
    nudged,
    skipped_busy: skippedBusy,
    skipped_same_window: skippedSameWindow,
    skipped_no_fit: skippedNoFit,
    skipped_no_chat: skippedNoChat,
    missed_stamped: missedStamped,
    missed_cleared: missedCleared,
  });
}

/**
 * For every recurring task the user has open, keep missed_cycle_key
 * consistent with reality:
 *
 *   - If the task has a stored missed key AND the current cycle key
 *     no longer matches it, the cycle has rolled over — clear the
 *     stale flag. (This is how a missed monday stops "counting"
 *     once tuesday arrives.)
 *   - Else if the task has a scheduling constraint AND its window
 *     is CLOSED at `now` AND we haven't already stamped this cycle
 *     as missed, stamp it.
 *
 * Non-recurring tasks are skipped: "missed a cycle" only makes
 * sense when there IS a next cycle to distinguish from. A one-off
 * task whose window has closed will simply not be nudge-eligible
 * anymore (constraint gate handles that), no bookkeeping needed.
 */
async function reconcileMissedCycles(
  env: Env, userId: number, openTasks: Task[], now: Date, timezone: string,
): Promise<{ stamped: number; cleared: number }> {
  let stamped = 0;
  let cleared = 0;

  for (const t of openTasks) {
    if (!t.is_recurring) continue;
    if (t.status !== 'pending') continue;

    const rule: RecurrenceRule | null = t.recurrence_rule
      ? safeParseRule(t.recurrence_rule)
      : null;
    const currentKey = cycleKeyForNow(rule, now, timezone);
    const constraint = safeParseStoredConstraint(t.schedule_constraint);

    // Clear stale key when the cycle has rolled over.
    if (t.missed_cycle_key && currentKey && t.missed_cycle_key !== currentKey) {
      await clearMissedCycleIfKeyMatches(env.DB, userId, t.id, t.missed_cycle_key);
      cleared++;
      continue;
    }

    // Only stamp missed cycles for tasks that HAVE a constraint —
    // without one there is no window to miss, and treating "still
    // open" as missed would blanket every recurring task in the
    // system with a flag it shouldn't have.
    if (!constraint) continue;
    if (!currentKey) continue;
    if (t.missed_cycle_key === currentKey) continue;

    if (isConstraintWindowClosedForCycle(constraint, now, timezone)) {
      await markMissedCycle(env.DB, userId, t.id, currentKey);
      stamped++;
    }
  }

  return { stamped, cleared };
}

function safeParseRule(json: string): RecurrenceRule | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && 'freq' in parsed) {
      return parsed as RecurrenceRule;
    }
    return null;
  } catch {
    return null;
  }
}

function formatNudgeMessage(
  task: Task,
  windowMinutes: number,
  now: Date,
): string {
  const grade = task.priority && task.priority !== DEFAULT_PRIORITY_INT
    ? ` (${priorityIntToLetter(task.priority)})`
    : '';
  const est = task.time_estimate_minutes && task.time_estimate_minutes > 0
    ? ` — ~${task.time_estimate_minutes}min`
    : '';
  const urg = urgencyLabel(task, now);
  const urgPart = urg ? ` [${urg}]` : '';
  const window = `~${windowMinutes}min free`;
  return (
    `Small gap? ${window}.\n` +
    `• #${task.id} ${task.title}${grade}${est}${urgPart}\n` +
    `No pressure — just a nudge.`
  );
}
