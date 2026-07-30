// Finance domain types. Amounts are stored in minor units (cents) as
// INTEGER in D1 to avoid floating-point drift; helpers in
// src/utils/money.ts convert to/from decimal strings at the edges.

import type { RecurrenceRule } from './shared';

export type ResponsibleParty = 'user' | 'other';
export type DebtStatus = 'open' | 'paid' | 'cancelled';

export interface BalanceRow {
  user_id: number;
  amount_cents: number;
  currency: string;
  /**
   * A separate per-user "undecided / set-aside" bucket. Same
   * currency as the main balance. Non-destructive movement in and
   * out via balance.ts helpers.
   */
  set_aside_cents: number;
  updated_at: string;
  created_at: string;
}

export interface DebtRow {
  id: number;
  user_id: number;
  creditor: string;
  amount_cents: number;
  currency: string;
  responsible_party: ResponsibleParty;
  on_behalf_of: string | null;
  due: string | null;
  /**
   * Stored INTEGER 1..15 mapping to A+..E- via src/utils/priority.ts.
   * Mirrors tasks.priority exactly — same scale, same helper.
   */
  urgency: number;
  status: DebtStatus;
  note: string | null;
  /** 0 or 1. Recurring debts (rent, subscriptions, monthly bills). */
  is_recurring: number;
  /** JSON string; same shape as tasks.recurrence_rule. */
  recurrence_rule: string | null;
  /** ISO timestamp of the last cron-driven reopen. Null before any reopen. */
  last_reopened_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingConfirmationRow {
  token: string;
  user_id: number;
  action: string;
  payload: string;   // JSON string
  summary: string;
  created_at: string;
  expires_at: string;
}

// Re-exported for callers that expect the recurrence type alongside
// the debt row. New code should prefer '../types/shared'.
export type { RecurrenceRule };
