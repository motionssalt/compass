// Bridges Gemini function calls to actual D1 operations.

import type { Env } from '../types/env';
import type { RecurrenceRule } from '../types/task';
import type { ResponsibleParty } from '../types/finance';
import {
  createTask, updateTaskStatus, cancelTask, listTasksByFilter,
  editTask, deleteTask,
} from '../db/tasks';
import { getUserTimezone } from '../db/users';
import { getBalance, setBalance, adjustBalance } from '../db/balance';
import {
  createDebt, editDebt, applyPaymentToDebt, markDebtPaid,
  cancelDebt, deleteDebt, listDebtsByFilter, getDebtById,
} from '../db/debts';
import { createConfirmation, consumeConfirmation } from '../db/confirmations';
import { parseAmountToCents, formatCents, formatMoney } from '../utils/money';
import { log } from '../utils/logger';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  response: Record<string, unknown>;
}

export async function executeTool(
  env: Env, userId: number, call: ToolCall,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      // ---- tasks ----
      case 'create_task':        return await handleCreate(env, userId, call.args);
      case 'update_task_status': return await handleUpdateStatus(env, userId, call.args);
      case 'cancel_task':        return await handleCancel(env, userId, call.args);
      case 'list_tasks':         return await handleList(env, userId, call.args);
      case 'edit_task':          return await handleEdit(env, userId, call.args);
      case 'delete_task':        return await handleDelete(env, userId, call.args);

      // ---- finance ----
      case 'record_income':          return await handleRecordIncome(env, userId, call.args);
      case 'record_spend':           return await handleRecordSpend(env, userId, call.args);
      case 'adjust_balance':         return await handleAdjustBalance(env, userId, call.args);
      case 'set_balance':            return await handleSetBalance(env, userId, call.args);
      case 'create_debt':            return await handleCreateDebt(env, userId, call.args);
      case 'edit_debt':              return await handleEditDebt(env, userId, call.args);
      case 'apply_payment_to_debt': return await handleApplyPayment(env, userId, call.args);
      case 'mark_debt_paid':         return await handleMarkPaid(env, userId, call.args);
      case 'cancel_debt':            return await handleCancelDebt(env, userId, call.args);
      case 'delete_debt':            return await handleDeleteDebt(env, userId, call.args);
      case 'list_debts':             return await handleListDebts(env, userId, call.args);
      case 'get_balance':            return await handleGetBalance(env, userId);
      case 'request_confirmation':   return await handleRequestConfirmation(env, userId, call.args);

      default:
        return { name: call.name, response: { ok: false, error: `Unknown tool: ${call.name}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('tool_exec_error', { tool: call.name, message });
    return { name: call.name, response: { ok: false, error: message } };
  }
}

// ---------------------------------------------------------------
// task handlers
// ---------------------------------------------------------------

async function handleCreate(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const title = String(args.title ?? '').trim();
  if (!title) {
    return { name: 'create_task', response: { ok: false, error: 'title is required' } };
  }
  const rule = args.recurrence_rule as RecurrenceRule | undefined;
  const task = await createTask(env.DB, {
    user_id: userId,
    title,
    priority: typeof args.priority === 'number' ? args.priority : 3,
    context_note: (args.context_note as string) ?? null,
    scheduled_for: (args.scheduled_for as string) ?? null,
    is_recurring: !!args.is_recurring,
    recurrence_rule: rule ?? null,
  });
  return { name: 'create_task', response: { ok: true, task } };
}

async function handleUpdateStatus(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.task_id);
  const status = String(args.status ?? '') as any;
  if (!id) return { name: 'update_task_status', response: { ok: false, error: 'task_id required' } };
  if (!['pending', 'in_progress', 'done', 'cancelled'].includes(status)) {
    return { name: 'update_task_status', response: { ok: false, error: `invalid status: ${status}` } };
  }
  const task = await updateTaskStatus(env.DB, userId, id, status);
  if (!task) return { name: 'update_task_status', response: { ok: false, error: 'task not found' } };
  return { name: 'update_task_status', response: { ok: true, task } };
}

async function handleCancel(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.task_id);
  if (!id) return { name: 'cancel_task', response: { ok: false, error: 'task_id required' } };
  const task = await cancelTask(env.DB, userId, id, (args.reason as string) ?? null);
  if (!task) return { name: 'cancel_task', response: { ok: false, error: 'task not found' } };
  return { name: 'cancel_task', response: { ok: true, task } };
}

async function handleList(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const filter = String(args.filter ?? 'pending') as any;
  const tz = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
  const tasks = await listTasksByFilter(env.DB, userId, filter, tz);
  return { name: 'list_tasks', response: { ok: true, filter, count: tasks.length, tasks } };
}

async function handleEdit(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.task_id);
  if (!id) return { name: 'edit_task', response: { ok: false, error: 'task_id required' } };
  const fields = (args.fields as Record<string, unknown>) ?? {};
  const task = await editTask(env.DB, userId, id, {
    title: fields.title as string | undefined,
    priority: fields.priority as number | undefined,
    context_note: fields.context_note as string | null | undefined,
    scheduled_for: fields.scheduled_for as string | null | undefined,
    is_recurring: fields.is_recurring as boolean | undefined,
    recurrence_rule: fields.recurrence_rule as RecurrenceRule | null | undefined,
    status: fields.status as any,
  });
  if (!task) return { name: 'edit_task', response: { ok: false, error: 'task not found' } };
  return { name: 'edit_task', response: { ok: true, task } };
}

async function handleDelete(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.task_id);
  if (!id) return { name: 'delete_task', response: { ok: false, error: 'task_id required' } };
  const ok = await deleteTask(env.DB, userId, id);
  return { name: 'delete_task', response: { ok, deleted_id: id } };
}

// ---------------------------------------------------------------
// finance handlers
// ---------------------------------------------------------------

/**
 * When we return a finance object to Gemini, we always add a
 * `_display` field with the human-readable amount so the model
 * doesn't have to think about cents. Storage stays in cents.
 */
function decorateDebt(d: any) {
  return {
    ...d,
    amount: formatCents(d.amount_cents),
    _display: formatMoney(d.amount_cents, d.currency),
  };
}
function decorateBalance(b: any) {
  return {
    ...b,
    amount: formatCents(b.amount_cents),
    _display: formatMoney(b.amount_cents, b.currency),
  };
}

async function handleRecordIncome(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const cents = parseAmountToCents(args.amount as string);
  if (cents === null || cents <= 0) {
    return { name: 'record_income', response: { ok: false, error: 'amount required and must be positive' } };
  }
  const before = await getBalance(env.DB, userId);
  const after = await adjustBalance(env.DB, userId, cents);
  return {
    name: 'record_income',
    response: {
      ok: true,
      applied: formatCents(cents),
      note: (args.note as string) ?? null,
      balance_before: decorateBalance(before),
      balance_after: decorateBalance(after),
    },
  };
}

async function handleRecordSpend(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const cents = parseAmountToCents(args.amount as string);
  if (cents === null || cents <= 0) {
    return { name: 'record_spend', response: { ok: false, error: 'amount required and must be positive' } };
  }
  const before = await getBalance(env.DB, userId);
  const after = await adjustBalance(env.DB, userId, -cents);
  return {
    name: 'record_spend',
    response: {
      ok: true,
      applied: `-${formatCents(cents)}`,
      note: (args.note as string) ?? null,
      balance_before: decorateBalance(before),
      balance_after: decorateBalance(after),
    },
  };
}

async function handleAdjustBalance(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const delta = parseAmountToCents(args.delta as string);
  if (delta === null) {
    return { name: 'adjust_balance', response: { ok: false, error: 'delta required (signed decimal string)' } };
  }
  const before = await getBalance(env.DB, userId);
  const after = await adjustBalance(env.DB, userId, delta);
  return {
    name: 'adjust_balance',
    response: {
      ok: true,
      applied: (delta >= 0 ? '+' : '') + formatCents(delta),
      note: (args.note as string) ?? null,
      balance_before: decorateBalance(before),
      balance_after: decorateBalance(after),
    },
  };
}

// Threshold for "big" overwrite. Beyond this we require a confirm
// token. Kept deliberately conservative — cheap confirmation is
// better than a silent destructive mistake.
const OVERWRITE_CONFIRM_ABS_CENTS = 100_00; // 100 units
const OVERWRITE_CONFIRM_REL       = 0.5;    // 50% change

async function handleSetBalance(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const cents = parseAmountToCents(args.amount as string);
  if (cents === null) {
    return { name: 'set_balance', response: { ok: false, error: 'amount required' } };
  }
  const currency = args.currency ? String(args.currency).toUpperCase() : undefined;

  const before = await getBalance(env.DB, userId, currency ?? 'USD');
  const diff = Math.abs(cents - before.amount_cents);
  const relDiff = before.amount_cents === 0 ? (cents === 0 ? 0 : 1) : diff / Math.abs(before.amount_cents);
  const needsConfirm = diff >= OVERWRITE_CONFIRM_ABS_CENTS && relDiff >= OVERWRITE_CONFIRM_REL;

  if (needsConfirm) {
    const token = args.confirm_token ? String(args.confirm_token) : '';
    if (!token) {
      return {
        name: 'set_balance',
        response: {
          ok: false,
          needs_confirmation: true,
          reason: 'large_overwrite',
          current: decorateBalance(before),
          proposed: { amount: formatCents(cents), currency: currency ?? before.currency },
          hint: 'Call request_confirmation with action="overwrite_balance", tell the user what will change, then re-call set_balance with the returned confirm_token.',
        },
      };
    }
    const row = await consumeConfirmation(env.DB, userId, token);
    if (!row || row.action !== 'overwrite_balance') {
      return { name: 'set_balance', response: { ok: false, error: 'invalid or expired confirm_token' } };
    }
  }

  const after = await setBalance(env.DB, userId, cents, currency);
  return {
    name: 'set_balance',
    response: {
      ok: true,
      balance_before: decorateBalance(before),
      balance_after: decorateBalance(after),
    },
  };
}

async function handleCreateDebt(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const creditor = String(args.creditor ?? '').trim();
  if (!creditor) {
    return { name: 'create_debt', response: { ok: false, error: 'creditor required' } };
  }
  const cents = parseAmountToCents(args.amount as string);
  if (cents === null || cents < 0) {
    return { name: 'create_debt', response: { ok: false, error: 'amount required and must be non-negative' } };
  }
  const responsibleRaw = String(args.responsible_party ?? 'user').toLowerCase();
  if (responsibleRaw !== 'user' && responsibleRaw !== 'other') {
    return { name: 'create_debt', response: { ok: false, error: 'responsible_party must be "user" or "other"' } };
  }
  const responsible = responsibleRaw as ResponsibleParty;

  // Default currency = user's balance currency.
  let currency = args.currency ? String(args.currency).toUpperCase() : undefined;
  if (!currency) {
    const bal = await getBalance(env.DB, userId);
    currency = bal.currency;
  }

  const debt = await createDebt(env.DB, {
    user_id: userId,
    creditor,
    amount_cents: cents,
    currency,
    responsible_party: responsible,
    on_behalf_of: (args.on_behalf_of as string) ?? null,
    due: (args.due as string) ?? null,
    urgency: typeof args.urgency === 'number' ? args.urgency : 3,
    note: (args.note as string) ?? null,
  });
  return { name: 'create_debt', response: { ok: true, debt: decorateDebt(debt) } };
}

async function handleEditDebt(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.debt_id);
  if (!id) return { name: 'edit_debt', response: { ok: false, error: 'debt_id required' } };
  const fields = (args.fields as Record<string, unknown>) ?? {};

  const patch: any = {};
  if (fields.creditor !== undefined) patch.creditor = String(fields.creditor);
  if (fields.amount !== undefined) {
    const c = parseAmountToCents(fields.amount as string);
    if (c === null) return { name: 'edit_debt', response: { ok: false, error: 'invalid amount' } };
    patch.amount_cents = c;
  }
  if (fields.currency !== undefined) patch.currency = String(fields.currency).toUpperCase();
  if (fields.responsible_party !== undefined) {
    const r = String(fields.responsible_party).toLowerCase();
    if (r !== 'user' && r !== 'other') {
      return { name: 'edit_debt', response: { ok: false, error: 'responsible_party must be "user" or "other"' } };
    }
    patch.responsible_party = r as ResponsibleParty;
  }
  if (fields.on_behalf_of !== undefined) patch.on_behalf_of = fields.on_behalf_of as string | null;
  if (fields.due !== undefined) patch.due = fields.due as string | null;
  if (fields.urgency !== undefined) patch.urgency = Number(fields.urgency);
  if (fields.note !== undefined) patch.note = fields.note as string | null;
  if (fields.status !== undefined) {
    const s = String(fields.status);
    if (!['open', 'paid', 'cancelled'].includes(s)) {
      return { name: 'edit_debt', response: { ok: false, error: `invalid status: ${s}` } };
    }
    patch.status = s;
  }

  const debt = await editDebt(env.DB, userId, id, patch);
  if (!debt) return { name: 'edit_debt', response: { ok: false, error: 'debt not found' } };
  return { name: 'edit_debt', response: { ok: true, debt: decorateDebt(debt) } };
}

async function handleApplyPayment(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.debt_id);
  if (!id) return { name: 'apply_payment_to_debt', response: { ok: false, error: 'debt_id required' } };
  const cents = parseAmountToCents(args.amount as string);
  if (cents === null || cents <= 0) {
    return { name: 'apply_payment_to_debt', response: { ok: false, error: 'amount required and must be positive' } };
  }

  const existing = await getDebtById(env.DB, userId, id);
  if (!existing) return { name: 'apply_payment_to_debt', response: { ok: false, error: 'debt not found' } };

  const fromBalance = !!args.from_balance;
  // Safety rail: never let the agent pay someone else's obligation
  // out of the user's balance, even if it asks.
  if (fromBalance && existing.responsible_party === 'other') {
    return {
      name: 'apply_payment_to_debt',
      response: {
        ok: false,
        error: 'refused: this debt\'s responsible_party is "other" — the user is only passing money through, do not deduct from their balance',
        debt: decorateDebt(existing),
      },
    };
  }

  const debt = await applyPaymentToDebt(env.DB, userId, id, cents);
  let balanceAfter = null;
  if (fromBalance) {
    balanceAfter = await adjustBalance(env.DB, userId, -cents);
  }
  return {
    name: 'apply_payment_to_debt',
    response: {
      ok: true,
      applied: formatCents(cents),
      debt: debt ? decorateDebt(debt) : null,
      balance_after: balanceAfter ? decorateBalance(balanceAfter) : null,
      note: (args.note as string) ?? null,
    },
  };
}

async function handleMarkPaid(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.debt_id);
  if (!id) return { name: 'mark_debt_paid', response: { ok: false, error: 'debt_id required' } };
  const debt = await markDebtPaid(env.DB, userId, id);
  if (!debt) return { name: 'mark_debt_paid', response: { ok: false, error: 'debt not found' } };
  return { name: 'mark_debt_paid', response: { ok: true, debt: decorateDebt(debt) } };
}

async function handleCancelDebt(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.debt_id);
  if (!id) return { name: 'cancel_debt', response: { ok: false, error: 'debt_id required' } };
  const debt = await cancelDebt(env.DB, userId, id);
  if (!debt) return { name: 'cancel_debt', response: { ok: false, error: 'debt not found' } };
  return { name: 'cancel_debt', response: { ok: true, debt: decorateDebt(debt) } };
}

async function handleDeleteDebt(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.debt_id);
  if (!id) return { name: 'delete_debt', response: { ok: false, error: 'debt_id required' } };
  const token = args.confirm_token ? String(args.confirm_token) : '';
  if (!token) {
    return {
      name: 'delete_debt',
      response: {
        ok: false,
        needs_confirmation: true,
        reason: 'destructive_delete',
        hint: 'Call request_confirmation with action="delete_debt" and payload={"debt_id":X}, ask the user to confirm, then re-call delete_debt with the returned confirm_token.',
      },
    };
  }
  const row = await consumeConfirmation(env.DB, userId, token);
  if (!row || row.action !== 'delete_debt') {
    return { name: 'delete_debt', response: { ok: false, error: 'invalid or expired confirm_token' } };
  }
  const ok = await deleteDebt(env.DB, userId, id);
  return { name: 'delete_debt', response: { ok, deleted_id: id } };
}

async function handleListDebts(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const filter = String(args.filter ?? 'open') as any;
  if (!['open', 'paid', 'cancelled', 'user', 'other', 'all'].includes(filter)) {
    return { name: 'list_debts', response: { ok: false, error: `invalid filter: ${filter}` } };
  }
  const debts = await listDebtsByFilter(env.DB, userId, filter);
  return {
    name: 'list_debts',
    response: { ok: true, filter, count: debts.length, debts: debts.map(decorateDebt) },
  };
}

async function handleGetBalance(env: Env, userId: number): Promise<ToolResult> {
  const bal = await getBalance(env.DB, userId);
  return { name: 'get_balance', response: { ok: true, balance: decorateBalance(bal) } };
}

async function handleRequestConfirmation(env: Env, userId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const action = String(args.action ?? '');
  if (!['delete_debt', 'overwrite_balance'].includes(action)) {
    return {
      name: 'request_confirmation',
      response: { ok: false, error: `unsupported action: ${action}` },
    };
  }
  const summary = String(args.summary ?? '').trim();
  if (!summary) {
    return { name: 'request_confirmation', response: { ok: false, error: 'summary required' } };
  }
  const payload = (args.payload as Record<string, unknown>) ?? {};
  const row = await createConfirmation(env.DB, userId, action, payload, summary);
  return {
    name: 'request_confirmation',
    response: {
      ok: true,
      confirm_token: row.token,
      expires_at: row.expires_at,
      action,
      summary,
      hint: 'Tell the user in plain language what will happen and wait for their reply. If they affirm, call the destructive tool with confirm_token=this token.',
    },
  };
}
