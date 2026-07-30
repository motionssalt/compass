// Nudge state — one row per user tracking the current free-window
// signature and the last-nudged task, plus a small helper to stamp
// `tasks.last_nudged_at` when the free-window nudger picks a task.
//
// Everything here is a direct D1 read/write — no Gemini path.

import { nowIso } from '../utils/time';

export interface NudgeStateRow {
  user_id: number;
  chat_id: number | null;
  last_window_signature: string | null;
  last_nudge_at: string | null;
  last_nudged_task_id: number | null;
  updated_at: string;
}

/**
 * Distinct users who have ever sent a message (i.e. have a users
 * row). Cheap enough for a low-frequency cron; a larger deployment
 * would want an "active-in-the-last-N-days" filter here.
 */
export async function listUsersForNudging(
  db: D1Database,
): Promise<Array<{ user_id: number; timezone: string | null }>> {
  const { results } = await db.prepare(
    `SELECT user_id, timezone FROM users`,
  ).all<{ user_id: number; timezone: string | null }>();
  return results ?? [];
}

export async function getNudgeState(
  db: D1Database, userId: number,
): Promise<NudgeStateRow | null> {
  const row = await db.prepare(
    `SELECT * FROM user_nudge_state WHERE user_id = ?1`,
  ).bind(userId).first<NudgeStateRow>();
  return row ?? null;
}

/**
 * Record the chat_id the bot should use to reach this user. Called
 * from the webhook on every inbound message so the nudge cron always
 * has an up-to-date destination.
 *
 * For private Telegram chats chat_id == user_id, but capturing it
 * explicitly keeps that assumption auditable.
 */
export async function rememberChatId(
  db: D1Database, userId: number, chatId: number,
): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO user_nudge_state (user_id, chat_id, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       chat_id    = excluded.chat_id,
       updated_at = excluded.updated_at`,
  ).bind(userId, chatId, now).run();
}

/**
 * Stamp a nudge: records the window signature so we don't renudge
 * the same window, the task id we picked, and the timestamp. Also
 * bumps `tasks.last_nudged_at` for the picked task so the fairness
 * scorer will down-rank it next time.
 */
export async function recordNudge(
  db: D1Database,
  userId: number,
  windowSignature: string,
  taskId: number,
): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO user_nudge_state
         (user_id, last_window_signature, last_nudge_at, last_nudged_task_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?3)
       ON CONFLICT(user_id) DO UPDATE SET
         last_window_signature = excluded.last_window_signature,
         last_nudge_at         = excluded.last_nudge_at,
         last_nudged_task_id   = excluded.last_nudged_task_id,
         updated_at            = excluded.updated_at`,
    ).bind(userId, windowSignature, now, taskId),
    db.prepare(
      `UPDATE tasks SET last_nudged_at = ?2 WHERE id = ?1 AND user_id = ?3`,
    ).bind(taskId, now, userId),
  ]);
}
