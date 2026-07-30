import { nowIso } from '../utils/time';

export interface ApiKeyRow {
  id: number;
  key_value: string;
  daily_quota: number;
  used_today: number;
  last_reset_date: string;
  is_active: number;
  consecutive_errors: number;
  last_error_message: string | null;
  last_used_at: string | null;
  created_at: string;
}

const ERROR_THRESHOLD = 3;

/** LRU-order active keys with remaining quota. */
export async function pickActiveKeys(db: D1Database): Promise<ApiKeyRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM api_keys
      WHERE is_active = 1
        AND used_today < daily_quota
      ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC`,
  ).all<ApiKeyRow>();
  return results ?? [];
}

export async function markKeyUsed(db: D1Database, id: number): Promise<void> {
  await db.prepare(
    `UPDATE api_keys
        SET used_today = used_today + 1,
            last_used_at = ?2,
            consecutive_errors = 0,
            last_error_message = NULL
      WHERE id = ?1`,
  ).bind(id, nowIso()).run();
}

export async function markKeyError(
  db: D1Database, id: number, message: string, disable = false,
): Promise<void> {
  if (disable) {
    await db.prepare(
      `UPDATE api_keys
          SET consecutive_errors = consecutive_errors + 1,
              last_error_message = ?2,
              is_active = 0,
              last_used_at = ?3
        WHERE id = ?1`,
    ).bind(id, message, nowIso()).run();
    return;
  }

  await db.prepare(
    `UPDATE api_keys
        SET consecutive_errors = consecutive_errors + 1,
            last_error_message = ?2,
            last_used_at = ?3,
            is_active = CASE
              WHEN consecutive_errors + 1 >= ?4 THEN 0
              ELSE is_active
            END
      WHERE id = ?1`,
  ).bind(id, message, nowIso(), ERROR_THRESHOLD).run();
}

/** Cron: reset daily counters and re-activate keys. */
export async function resetDailyQuotas(db: D1Database, todayLocal: string): Promise<number> {
  const res = await db.prepare(
    `UPDATE api_keys
        SET used_today = 0,
            last_reset_date = ?1,
            is_active = 1,
            consecutive_errors = 0,
            last_error_message = NULL`,
  ).bind(todayLocal).run();
  return res.meta?.changes ?? 0;
}
