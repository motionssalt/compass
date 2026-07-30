// Finance domain types. Amounts are stored in minor units (cents) as
// INTEGER in D1 to avoid floating-point drift; helpers in
// src/utils/money.ts convert to/from decimal strings at the edges.

export type ResponsibleParty = 'user' | 'other';
export type DebtStatus = 'open' | 'paid' | 'cancelled';

export interface BalanceRow {
  user_id: number;
  amount_cents: number;
  currency: string;
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
  urgency: number;
  status: DebtStatus;
  note: string | null;
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
