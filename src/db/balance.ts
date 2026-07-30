import type { BalanceRow } from '../types/finance';
import { nowIso } from '../utils/time';

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------

/**
 * Fetch the user's balance row, materialising a zero row on first
 * read so callers can always assume one exists.
 */
export async function getBalance(
  db: D1Database, userId: number, defaultCurrency = 'USD',
): Promise<BalanceRow> {
  const row = await db.prepare(
    `SELECT * FROM user_balance WHERE user_id = ?1`,
  ).bind(userId).first<BalanceRow>();
  if (row) return row;

  const now = nowIso();
  await db.prepare(
    `INSERT INTO user_balance (user_id, amount_cents, currency, updated_at, created_at)
     VALUES (?1, 0, ?2, ?3, ?3)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(userId, defaultCurrency, now).run();

  const fresh = await db.prepare(
    `SELECT * FROM user_balance WHERE user_id = ?1`,
  ).bind(userId).first<BalanceRow>();
  return fresh!;
}

// ---------------------------------------------------------------
// Write
// ---------------------------------------------------------------

/** Overwrite the balance to an exact amount (destructive). */
export async function setBalance(
  db: D1Database, userId: number, amountCents: number, currency?: string,
): Promise<BalanceRow> {
  // Ensure a row exists first so the UPDATE actually hits something.
  await getBalance(db, userId, currency ?? 'USD');
  const now = nowIso();
  if (currency) {
    await db.prepare(
      `UPDATE user_balance
          SET amount_cents = ?2, currency = ?3, updated_at = ?4
        WHERE user_id = ?1`,
    ).bind(userId, amountCents, currency, now).run();
  } else {
    await db.prepare(
      `UPDATE user_balance
          SET amount_cents = ?2, updated_at = ?3
        WHERE user_id = ?1`,
    ).bind(userId, amountCents, now).run();
  }
  return getBalance(db, userId, currency ?? 'USD');
}

/**
 * Add a signed delta to the balance. Positive for income / money
 * arriving, negative for spend / payment applied.
 */
export async function adjustBalance(
  db: D1Database, userId: number, deltaCents: number,
): Promise<BalanceRow> {
  await getBalance(db, userId);
  const now = nowIso();
  await db.prepare(
    `UPDATE user_balance
        SET amount_cents = amount_cents + ?2, updated_at = ?3
      WHERE user_id = ?1`,
  ).bind(userId, deltaCents, now).run();
  return getBalance(db, userId);
}
