// Duration-aware free-time nudger.
//
// Runs on its OWN, higher-frequency cron trigger (separate from the
// existing daily reset in cron.ts). Pure D1 + Telegram — no Gemini,
// no runAgent, no quota burn.
//
// Per user, per tick:
//   1. Load open tasks.
//   2. Compute the current free window (see utils/freeWindow.ts).
//   3. If busy, skip.
//   4. If the window's signature matches the last-nudged signature,
//      skip (we already nudged for this window).
//   5. Score flexible tasks (utils/nudgeScoring.ts), pick the best
//      fit, record the nudge, and send a Telegram message.
//
// One nudge per free window is the entire contract — the fairness
// check on window signature enforces it.

import type { Env } from '../types/env';
import { listOpenTasks } from '../db/tasks';
import { getUserTimezone } from '../db/users';
import {
  listUsersForNudging, getNudgeState, recordNudge,
} from '../db/nudge';
import { computeFreeWindow } from '../utils/freeWindow';
import { pickNudgeTask } from '../utils/nudgeScoring';
import { priorityIntToLetter, DEFAULT_PRIORITY_INT } from '../utils/priority';
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

      const pick = pickNudgeTask(openTasks, window, now);
      if (!pick) {
        // Still stamp the signature so we don't retry every tick.
        await recordNudge(env.DB, u.user_id, window.signature, 0);
        skippedNoFit++;
        continue;
      }

      const message = formatNudgeMessage(pick.task, window.minutesAvailable!);
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
  });
}

function formatNudgeMessage(task: { id: number; title: string; priority: number; time_estimate_minutes: number | null }, windowMinutes: number): string {
  const grade = task.priority && task.priority !== DEFAULT_PRIORITY_INT
    ? ` (${priorityIntToLetter(task.priority)})`
    : '';
  const est = task.time_estimate_minutes && task.time_estimate_minutes > 0
    ? ` — ~${task.time_estimate_minutes}min`
    : '';
  const window = `~${windowMinutes}min free`;
  return (
    `Small gap? ${window}.\n` +
    `• #${task.id} ${task.title}${grade}${est}\n` +
    `No pressure — just a nudge.`
  );
}
