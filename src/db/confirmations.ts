import type { PendingConfirmationRow } from '../types/finance';
import { nowIso } from '../utils/time';

// ---------------------------------------------------------------
// Pending confirmations for destructive financial actions.
//
// Flow:
//   1. Agent decides a destructive action is warranted (delete a
//      debt, overwrite the balance to a very different value).
//   2. Agent calls the request_confirmation tool with the action name
//      and its arguments; the runtime stores a row here, returns the
//      token to the agent, and the agent asks the user "you're about
//      to X, confirm?"
//   3. On the next user turn, the agent calls the corresponding
//      execute-tool with the token; the runtime consumes the row and
//      performs the action.
//
// Tokens expire quickly (see CONFIRMATION_TTL_SECONDS) so a stale
// "yes" from a much older conversation cannot silently drop data.
// ---------------------------------------------------------------

export const CONFIRMATION_TTL_SECONDS = 15 * 60; // 15 minutes

function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // Simple url-safe base36-ish encoding (no external deps).
  return Array.from(bytes).map((b) => b.toString(36).padStart(2, '0')).join('');
}

export async function createConfirmation(
  db: D1Database, userId: number, action: string,
  payload: Record<string, unknown>, summary: string,
): Promise<PendingConfirmationRow> {
  const token = randomToken();
  const now = nowIso();
  const expires = new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000).toISOString();

  await db.prepare(
    `INSERT INTO pending_confirmations
       (token, user_id, action, payload, summary, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(token, userId, action, JSON.stringify(payload), summary, now, expires).run();

  const row = await db.prepare(
    `SELECT * FROM pending_confirmations WHERE token = ?1`,
  ).bind(token).first<PendingConfirmationRow>();
  return row!;
}

/**
 * Fetch AND delete a pending confirmation atomically-ish. Returns
 * null if the token is unknown, expired, or belongs to a different
 * user (defensive — the runtime already scopes by userId in the
 * tool executor).
 */
export async function consumeConfirmation(
  db: D1Database, userId: number, token: string,
): Promise<PendingConfirmationRow | null> {
  const row = await db.prepare(
    `SELECT * FROM pending_confirmations
      WHERE token = ?1 AND user_id = ?2`,
  ).bind(token, userId).first<PendingConfirmationRow>();
  if (!row) return null;

  // Always delete on read — a confirmation is single-use.
  await db.prepare(
    `DELETE FROM pending_confirmations WHERE token = ?1`,
  ).bind(token).run();

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  return row;
}

/** Housekeeping — best-effort cleanup called from the daily cron. */
export async function purgeExpiredConfirmations(db: D1Database): Promise<number> {
  const res = await db.prepare(
    `DELETE FROM pending_confirmations WHERE expires_at < ?1`,
  ).bind(nowIso()).run();
  return res.meta?.changes ?? 0;
}
