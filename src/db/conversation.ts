import { nowIso } from '../utils/time';

export interface ConversationRow {
  id: number;
  user_id: number;
  role: 'user' | 'model' | 'tool';
  content: string;
  created_at: string;
}

export async function appendMessage(
  db: D1Database, userId: number, role: ConversationRow['role'], content: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO conversation_log (user_id, role, content, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(userId, role, content, nowIso()).run();
}

export async function recentMessages(
  db: D1Database, userId: number, limit: number,
): Promise<ConversationRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM conversation_log
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT ?2`,
  ).bind(userId, limit).all<ConversationRow>();
  return (results ?? []).reverse();
}

/** Trim old rows so the table doesn't grow forever. */
export async function pruneOld(db: D1Database, userId: number, keep: number): Promise<void> {
  await db.prepare(
    `DELETE FROM conversation_log
      WHERE user_id = ?1
        AND id NOT IN (
          SELECT id FROM conversation_log
           WHERE user_id = ?1
           ORDER BY created_at DESC
           LIMIT ?2
        )`,
  ).bind(userId, keep).run();
}
