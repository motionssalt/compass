import type { DebtRow, DebtStatus, ResponsibleParty } from '../types/finance';
import { nowIso } from '../utils/time';

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
  filter: 'open' | 'paid' | 'cancelled' | 'user' | 'other' | 'all',
): Promise<DebtRow[]> {
  if (filter === 'all') {
    const { results } = await db.prepare(
      `SELECT * FROM debts WHERE user_id = ?1
        ORDER BY status ASC, urgency ASC, created_at DESC
        LIMIT 200`,
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
  urgency?: number;
  note?: string | null;
}

export async function createDebt(db: D1Database, input: CreateDebtInput): Promise<DebtRow> {
  const now = nowIso();
  const urgency = clampUrgency(input.urgency ?? 3);
  const responsible: ResponsibleParty = input.responsible_party ?? 'user';

  const row = await db.prepare(
    `INSERT INTO debts
       (user_id, creditor, amount_cents, currency, responsible_party,
        on_behalf_of, due, urgency, status, note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?10)
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
  urgency?: number;
  note?: string | null;
  status?: DebtStatus;
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
    urgency: fields.urgency !== undefined ? clampUrgency(fields.urgency) : existing.urgency,
    note: fields.note !== undefined ? fields.note : existing.note,
    status: fields.status ?? existing.status,
  };

  const row = await db.prepare(
    `UPDATE debts
        SET creditor = ?3, amount_cents = ?4, currency = ?5,
            responsible_party = ?6, on_behalf_of = ?7, due = ?8,
            urgency = ?9, note = ?10, status = ?11, updated_at = ?12
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(
    id, userId,
    merged.creditor, merged.amount_cents, merged.currency,
    merged.responsible_party, merged.on_behalf_of, merged.due,
    merged.urgency, merged.note, merged.status,
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

function clampUrgency(u: number): number {
  if (!Number.isFinite(u)) return 3;
  return Math.max(1, Math.min(5, Math.round(u)));
}
