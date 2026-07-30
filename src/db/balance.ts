import type { BalanceRow } from '../types/finance';
import { nowIso } from '../utils/time';
import { getUserDefaultCurrency } from './users';

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------

/**
 * Fetch the user's balance row, materialising a zero row on first
 * read so callers can always assume one exists.
 *
 * If the caller doesn't pass an explicit `defaultCurrency`, we look
 * up the user's stored default (users.default_currency) and fall
 * back to 'USD' only when they've never set one. This is the single
 * chokepoint where the hardcoded 'USD' used to leak out.
 */
export async function getBalance(
  db: D1Database, userId: number, defaultCurrency?: string,
): Promise<BalanceRow> {
  const row = await db.prepare(
    `SELECT * FROM user_balance WHERE user_id = ?1`,
  ).bind(userId).first<BalanceRow>();
  if (row) return row;

  const currency = defaultCurrency
    ?? (await getUserDefaultCurrency(db, userId))
    ?? 'USD';
  const now = nowIso();
  await db.prepare(
    `INSERT INTO user_balance
       (user_id, amount_cents, currency, set_aside_cents, updated_at, created_at)
     VALUES (?1, 0, ?2, 0, ?3, ?3)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(userId, currency, now).run();

  const fresh = await db.prepare(
    `SELECT * FROM user_balance WHERE user_id = ?1`,
  ).bind(userId).first<BalanceRow>();
  return fresh!;
}

// ---------------------------------------------------------------
// Write — main balance
// ---------------------------------------------------------------

/** Overwrite the balance to an exact amount (destructive). */
export async function setBalance(
  db: D1Database, userId: number, amountCents: number, currency?: string,
): Promise<BalanceRow> {
  // Ensure a row exists first so the UPDATE actually hits something.
  await getBalance(db, userId, currency);
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
  return getBalance(db, userId, currency);
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

// ---------------------------------------------------------------
// Write — set-aside / "undecided" bucket
// ---------------------------------------------------------------
//
// Same currency as the main balance (there's no per-bucket currency
// column). The bucket is deliberately frictionless: moving money in
// and out is non-destructive and needs no confirmation, mirroring
// adjustBalance in style.

/**
 * Move `amountCents` from the main balance into the set-aside
 * bucket. Positive-only. Overdraws the main balance freely (going
 * negative is allowed — the whole balance can be negative anyway,
 * per adjustBalance).
 */
export async function moveToSetAside(
  db: D1Database, userId: number, amountCents: number,
): Promise<BalanceRow> {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('moveToSetAside: amount must be a positive integer');
  }
  await getBalance(db, userId);
  const now = nowIso();
  await db.prepare(
    `UPDATE user_balance
        SET amount_cents    = amount_cents - ?2,
            set_aside_cents = set_aside_cents + ?2,
            updated_at      = ?3
      WHERE user_id = ?1`,
  ).bind(userId, amountCents, now).run();
  return getBalance(db, userId);
}

/**
 * Move `amountCents` from the set-aside bucket back into the main
 * balance. Positive-only. If the bucket doesn't have enough, we
 * still transfer the requested amount (the bucket can go negative
 * for the same reason the main balance can — same currency, same
 * accounting posture).
 */
export async function moveFromSetAside(
  db: D1Database, userId: number, amountCents: number,
): Promise<BalanceRow> {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('moveFromSetAside: amount must be a positive integer');
  }
  await getBalance(db, userId);
  const now = nowIso();
  await db.prepare(
    `UPDATE user_balance
        SET amount_cents    = amount_cents + ?2,
            set_aside_cents = set_aside_cents - ?2,
            updated_at      = ?3
      WHERE user_id = ?1`,
  ).bind(userId, amountCents, now).run();
  return getBalance(db, userId);
}
