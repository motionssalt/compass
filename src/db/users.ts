import { nowIso } from '../utils/time';

export interface UserRow {
  user_id: number;
  first_name: string | null;
  username: string | null;
  timezone: string | null;
  /**
   * User's chosen default currency (3-letter code). Null when the
   * user has never picked one — callers should fall back to 'USD'
   * only in that case.
   */
  default_currency: string | null;
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

/**
 * Validate that `tz` is a real IANA timezone identifier the runtime
 * recognises. We rely on `Intl.DateTimeFormat` throwing a RangeError
 * for unknown zones — Cloudflare Workers ship the full ICU tz
 * database, so this correctly accepts things like "America/New_York"
 * or "Africa/Lagos" and rejects typos like "America/New_york" or
 * "Nairobi".
 *
 * Fixed-offset strings ("UTC+3", "GMT-5") are deliberately rejected
 * — DST transitions and future law changes make them unsafe for the
 * daily-rollover / "today" logic that reads this column.
 */
export function isValidIanaTimezone(tz: string): boolean {
  const trimmed = String(tz ?? '').trim();
  if (!trimmed) return false;
  // Must look like a Region/City identifier (also allowing "UTC" and
  // a handful of legacy single-segment zones like "GMT", "Zulu").
  // The Intl check below is the real gate; this cheap pre-check just
  // filters out obviously-bogus values before touching Intl.
  if (!/^[A-Za-z]+(?:[_+\-][A-Za-z0-9]+)*(?:\/[A-Za-z]+(?:[_+\-][A-Za-z0-9]+)*)*$/.test(trimmed)) {
    return false;
  }
  try {
    // Intl throws RangeError on unknown IANA identifiers.
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the user's IANA timezone (e.g. "Africa/Nairobi"). Materialises
 * a users row if one doesn't exist yet. Rejects invalid identifiers
 * — the caller (slash command handler) is expected to surface a
 * friendly usage message on rejection.
 *
 * Returns the stored (trimmed) identifier on success.
 */
export async function setUserTimezone(
  db: D1Database, userId: number, tz: string,
): Promise<string> {
  const value = String(tz ?? '').trim();
  if (!isValidIanaTimezone(value)) {
    throw new Error('timezone must be a valid IANA identifier (e.g. America/New_York, Africa/Lagos)');
  }
  const now = nowIso();
  await db.prepare(
    `INSERT INTO users (user_id, timezone, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       timezone   = excluded.timezone,
       updated_at = excluded.updated_at`,
  ).bind(userId, value, now).run();
  return value;
}

// ---------------------------------------------------------------
// default currency
// ---------------------------------------------------------------

/**
 * Fetch the user's chosen default currency, or null if they've
 * never set one. Callers that need a concrete value fall back to
 * 'USD' at their own layer (see balance.getBalance).
 */
export async function getUserDefaultCurrency(
  db: D1Database, userId: number,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT default_currency FROM users WHERE user_id = ?1`,
  ).bind(userId).first<{ default_currency: string | null }>();
  const v = row?.default_currency;
  if (!v) return null;
  const trimmed = String(v).trim().toUpperCase();
  return trimmed || null;
}

/**
 * Set the user's default currency. Materialises a users row if one
 * doesn't exist yet (upsertUser is normally called on first message,
 * but this shouldn't crash if it hasn't been). Normalises to
 * uppercase 3-letter code; anything else is rejected.
 */
export async function setUserDefaultCurrency(
  db: D1Database, userId: number, currency: string,
): Promise<string> {
  const code = String(currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error('currency must be a 3-letter code (e.g. USD, KES, EUR)');
  }
  const now = nowIso();
  await db.prepare(
    `INSERT INTO users (user_id, default_currency, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       default_currency = excluded.default_currency,
       updated_at       = excluded.updated_at`,
  ).bind(userId, code, now).run();
  return code;
}
