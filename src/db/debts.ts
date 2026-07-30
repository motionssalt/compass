import type { DebtRow, DebtStatus, ResponsibleParty } from '../types/finance';
import type { RecurrenceRule } from '../types/shared';
import { nowIso, localWeekday } from '../utils/time';
import {
  normalisePriorityToInt,
  DEFAULT_PRIORITY_INT,
} from '../utils/priority';

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------

export async function listOpenDebts(
  db: D1Database, userId: number,
): Promise<DebtRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM debts
      WHERE user_id = ?1 AND status = 'open'
      ORDER BY
        CASE responsible_party WHEN 'user' THEN 0 ELSE 1 END,
        urgency ASC,
        created_at ASC`,
  ).bind(userId).all<DebtRow>();
  return results ?? [];
}

export async function listDebtsByFilter(
  db: D1Database, userId: number,
  filter: 'open' | 'paid' | 'cancelled' | 'user' | 'other' | 'all' | 'recurring',
): Promise<DebtRow[]> {
  if (filter === 'all') {
    const { results } = await db.prepare(
      `SELECT * FROM debts WHERE user_id = ?1
        ORDER BY status ASC, urgency ASC, created_at DESC
        LIMIT 200`,
    ).bind(userId).all<DebtRow>();
    return results ?? [];
  }
  if (filter === 'recurring') {
    const { results } = await db.prepare(
      `SELECT * FROM debts
        WHERE user_id = ?1 AND is_recurring = 1
        ORDER BY urgency ASC, creditor ASC`,
    ).bind(userId).all<DebtRow>();
    return results ?? [];
  }
  if (filter === 'user' || filter === 'other') {
    const { results } = await db.prepare(
      `SELECT * FROM debts
        WHERE user_id = ?1 AND responsible_party = ?2 AND status = 'open'
        ORDER BY urgency ASC, created_at ASC`,
    ).bind(userId, filter).all<DebtRow>();
    return results ?? [];
  }
  const { results } = await db.prepare(
    `SELECT * FROM debts
      WHERE user_id = ?1 AND status = ?2
      ORDER BY urgency ASC, created_at DESC
      LIMIT 200`,
  ).bind(userId, filter).all<DebtRow>();
  return results ?? [];
}

export async function getDebtById(
  db: D1Database, userId: number, id: number,
): Promise<DebtRow | null> {
  const row = await db.prepare(
    `SELECT * FROM debts WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId).first<DebtRow>();
  return row ?? null;
}

// ---------------------------------------------------------------
// Write
// ---------------------------------------------------------------

export interface CreateDebtInput {
  user_id: number;
  creditor: string;
  amount_cents: number;
  currency?: string;
  responsible_party?: ResponsibleParty;
  on_behalf_of?: string | null;
  due?: string | null;
  /** Letter grade (A+..E-) or a normalised integer. See utils/priority.ts. */
  urgency?: string | number;
  note?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
}

export async function createDebt(db: D1Database, input: CreateDebtInput): Promise<DebtRow> {
  const now = nowIso();
  const urgency = input.urgency === undefined
    ? DEFAULT_PRIORITY_INT
    : normalisePriorityToInt(input.urgency);
  const responsible: ResponsibleParty = input.responsible_party ?? 'user';
  const ruleJson = input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : null;

  const row = await db.prepare(
    `INSERT INTO debts
       (user_id, creditor, amount_cents, currency, responsible_party,
        on_behalf_of, due, urgency, status, note,
        is_recurring, recurrence_rule,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?11, ?12, ?12)
     RETURNING *`,
  ).bind(
    input.user_id,
    input.creditor.trim(),
    input.amount_cents,
    input.currency ?? 'USD',
    responsible,
    input.on_behalf_of ?? null,
    input.due ?? null,
    urgency,
    input.note ?? null,
    input.is_recurring ? 1 : 0,
    ruleJson,
    now,
  ).first<DebtRow>();

  if (!row) throw new Error('Failed to insert debt');
  return row;
}

export interface EditDebtFields {
  creditor?: string;
  amount_cents?: number;
  currency?: string;
  responsible_party?: ResponsibleParty;
  on_behalf_of?: string | null;
  due?: string | null;
  /** Letter grade (A+..E-) or a normalised integer. */
  urgency?: string | number;
  note?: string | null;
  status?: DebtStatus;
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
}

export async function editDebt(
  db: D1Database, userId: number, id: number, fields: EditDebtFields,
): Promise<DebtRow | null> {
  const existing = await getDebtById(db, userId, id);
  if (!existing) return null;

  const merged = {
    creditor: fields.creditor ?? existing.creditor,
    amount_cents: fields.amount_cents !== undefined ? fields.amount_cents : existing.amount_cents,
    currency: fields.currency ?? existing.currency,
    responsible_party: fields.responsible_party ?? existing.responsible_party,
    on_behalf_of: fields.on_behalf_of !== undefined ? fields.on_behalf_of : existing.on_behalf_of,
    due: fields.due !== undefined ? fields.due : existing.due,
    urgency: fields.urgency !== undefined
      ? normalisePriorityToInt(fields.urgency)
      : existing.urgency,
    note: fields.note !== undefined ? fields.note : existing.note,
    status: fields.status ?? existing.status,
    is_recurring: fields.is_recurring !== undefined
      ? (fields.is_recurring ? 1 : 0)
      : existing.is_recurring,
    recurrence_rule: fields.recurrence_rule !== undefined
      ? (fields.recurrence_rule ? JSON.stringify(fields.recurrence_rule) : null)
      : existing.recurrence_rule,
  };

  const row = await db.prepare(
    `UPDATE debts
        SET creditor = ?3, amount_cents = ?4, currency = ?5,
            responsible_party = ?6, on_behalf_of = ?7, due = ?8,
            urgency = ?9, note = ?10, status = ?11,
            is_recurring = ?12, recurrence_rule = ?13,
            updated_at = ?14
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(
    id, userId,
    merged.creditor, merged.amount_cents, merged.currency,
    merged.responsible_party, merged.on_behalf_of, merged.due,
    merged.urgency, merged.note, merged.status,
    merged.is_recurring, merged.recurrence_rule,
    nowIso(),
  ).first<DebtRow>();

  return row ?? null;
}

/**
 * Apply a payment to a debt, decrementing its outstanding balance.
 * Auto-flips status to 'paid' when it hits zero (or negative — over-
 * payment is treated as full payment; any leftover stays on the
 * user's balance and the caller is responsible for that side).
 */
export async function applyPaymentToDebt(
  db: D1Database, userId: number, id: number, amountCents: number,
): Promise<DebtRow | null> {
  const existing = await getDebtById(db, userId, id);
  if (!existing) return null;
  const remaining = existing.amount_cents - amountCents;
  const nextStatus: DebtStatus = remaining <= 0 ? 'paid' : existing.status;
  const nextAmount = Math.max(remaining, 0);

  const row = await db.prepare(
    `UPDATE debts
        SET amount_cents = ?3, status = ?4, updated_at = ?5
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(id, userId, nextAmount, nextStatus, nowIso()).first<DebtRow>();
  return row ?? null;
}

export async function markDebtPaid(
  db: D1Database, userId: number, id: number,
): Promise<DebtRow | null> {
  const row = await db.prepare(
    `UPDATE debts
        SET amount_cents = 0, status = 'paid', updated_at = ?3
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(id, userId, nowIso()).first<DebtRow>();
  return row ?? null;
}

export async function cancelDebt(
  db: D1Database, userId: number, id: number,
): Promise<DebtRow | null> {
  const row = await db.prepare(
    `UPDATE debts
        SET status = 'cancelled', updated_at = ?3
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(id, userId, nowIso()).first<DebtRow>();
  return row ?? null;
}

export async function deleteDebt(
  db: D1Database, userId: number, id: number,
): Promise<boolean> {
  const res = await db.prepare(
    `DELETE FROM debts WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------
// Recurring debts
// ---------------------------------------------------------------
//
// Mirrors the tasks-side pattern: for each recurring debt whose rule
// fires today, if the current status is paid/cancelled, reopen it so
// it shows up again in "what should I pay?". The actual outstanding
// amount is NOT reset here — a caller that wants a fresh cycle can
// pass a per-cycle amount via `resetAmountCents` (analogous to how a
// task's status flips back to pending but its content stays intact).
//
// Not wired into the cron in this part — that's a follow-up.

/**
 * True when the debt's recurrence rule fires on `weekday`.
 * Missing / malformed rule falls back to "fires every day" so a
 * recurring flag with no rule is still treated as recurring-daily,
 * matching how tasks.ts handles the same case.
 */
export function recurringDebtFiresOn(
  debt: DebtRow, weekday: string,
): boolean {
  if (!debt.recurrence_rule) return true;
  try {
    const rule = JSON.parse(debt.recurrence_rule) as RecurrenceRule;
    if (rule.freq === 'daily') return true;
    if (rule.freq === 'weekly') return !!rule.days?.includes(weekday);
  } catch {
    return true;
  }
  return false;
}

/**
 * Reopen recurring debts whose rule fires today. Analogous to
 * tasks.resetRecurringForDay. Flips paid/cancelled recurring debts
 * back to 'open' and stamps `last_reopened_at`. Returns the number
 * of debts touched.
 */
export async function reopenRecurringForDay(
  db: D1Database, timezone: string,
): Promise<number> {
  const weekday = localWeekday(new Date(), timezone);
  const { results } = await db.prepare(
    `SELECT * FROM debts WHERE is_recurring = 1`,
  ).all<DebtRow>();

  let reopenedCount = 0;
  for (const d of results ?? []) {
    if (!recurringDebtFiresOn(d, weekday)) continue;
    if (d.status === 'paid' || d.status === 'cancelled') {
      const now = nowIso();
      await db.prepare(
        `UPDATE debts
            SET status = 'open',
                last_reopened_at = ?2,
                updated_at = ?2
          WHERE id = ?1`,
      ).bind(d.id, now).run();
      reopenedCount++;
    }
  }
  return reopenedCount;
}
