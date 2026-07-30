import { nowIso } from '../utils/time';

export interface UserRow {
  user_id: number;
  first_name: string | null;
  username: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export async function upsertUser(
  db: D1Database,
  userId: number,
  firstName: string | null,
  username: string | null,
): Promise<UserRow> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO users (user_id, first_name, username, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       first_name = excluded.first_name,
       username   = excluded.username,
       updated_at = excluded.updated_at`,
  ).bind(userId, firstName, username, now).run();

  const row = await db.prepare(
    `SELECT * FROM users WHERE user_id = ?1`,
  ).bind(userId).first<UserRow>();
  return row!;
}

export async function getUserTimezone(
  db: D1Database, userId: number, fallback: string,
): Promise<string> {
  const row = await db.prepare(
    `SELECT timezone FROM users WHERE user_id = ?1`,
  ).bind(userId).first<{ timezone: string | null }>();
  return row?.timezone || fallback;
}
