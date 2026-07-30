// Short-lived state store for multi-step inline-keyboard flows.
//
// This is a sibling to src/db/confirmations.ts, NOT a replacement.
// pending_confirmations stays as-is for the destructive-action
// confirm-before-execute pattern (single-use tokens for
// delete_debt / overwrite_balance). This module handles a different
// shape: a per-user "you tapped Add Task, we're now waiting for a
// free-text title" state that spans several inbound updates and
// mutates as the flow progresses.
//
// One row per user, max. Any new /menu press or a completed /
// cancelled flow deletes the row.

import { nowIso } from '../utils/time';

export const FLOW_TTL_SECONDS = 15 * 60; // 15 minutes — matches confirmations

export interface FlowRow {
  user_id: number;
  flow: string;
  step: string;
  state: string;             // JSON string
  chat_id: number | null;
  prompt_msg_id: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Parsed convenience wrapper — most callers want the decoded state,
 * not the raw JSON string.
 */
export interface FlowState<T extends Record<string, unknown> = Record<string, unknown>> {
  user_id: number;
  flow: string;
  step: string;
  state: T;
  chat_id: number | null;
  prompt_msg_id: number | null;
}

function decodeRow<T extends Record<string, unknown>>(row: FlowRow): FlowState<T> {
  let state: T;
  try { state = JSON.parse(row.state) as T; }
  catch { state = {} as T; }
  return {
    user_id: row.user_id,
    flow: row.flow,
    step: row.step,
    state,
    chat_id: row.chat_id,
    prompt_msg_id: row.prompt_msg_id,
  };
}

/**
 * Start (or replace) a flow for `userId`. Any prior flow is
 * overwritten — the user tapping a new menu entry cancels whatever
 * they were mid-way through, which is the least-surprising behaviour.
 */
export async function startFlow<T extends Record<string, unknown>>(
  db: D1Database,
  userId: number,
  flow: string,
  step: string,
  state: T,
  chatId: number | null,
  promptMsgId: number | null,
): Promise<FlowState<T>> {
  const now = nowIso();
  const expires = new Date(Date.now() + FLOW_TTL_SECONDS * 1000).toISOString();
  await db.prepare(
    `INSERT INTO pending_flows
       (user_id, flow, step, state, chat_id, prompt_msg_id, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
     ON CONFLICT(user_id) DO UPDATE SET
       flow          = excluded.flow,
       step          = excluded.step,
       state         = excluded.state,
       chat_id       = excluded.chat_id,
       prompt_msg_id = excluded.prompt_msg_id,
       updated_at    = excluded.updated_at,
       expires_at    = excluded.expires_at`,
  ).bind(
    userId, flow, step, JSON.stringify(state ?? {}),
    chatId, promptMsgId, now, expires,
  ).run();

  const row = await db.prepare(
    `SELECT * FROM pending_flows WHERE user_id = ?1`,
  ).bind(userId).first<FlowRow>();
  return decodeRow<T>(row!);
}

/**
 * Fetch the current flow, or null if none / expired. Expired rows
 * are treated as absent AND deleted to keep the table small.
 */
export async function getFlow<T extends Record<string, unknown> = Record<string, unknown>>(
  db: D1Database, userId: number,
): Promise<FlowState<T> | null> {
  const row = await db.prepare(
    `SELECT * FROM pending_flows WHERE user_id = ?1`,
  ).bind(userId).first<FlowRow>();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await clearFlow(db, userId);
    return null;
  }
  return decodeRow<T>(row);
}

/**
 * Advance an existing flow: update its step and merge extra state
 * fields on top of what's already stored. If no flow exists, this
 * is a no-op returning null (caller decided to seed via startFlow).
 */
export async function advanceFlow<T extends Record<string, unknown>>(
  db: D1Database,
  userId: number,
  step: string,
  stateMerge: Partial<T>,
  promptMsgId?: number | null,
): Promise<FlowState<T> | null> {
  const current = await getFlow<T>(db, userId);
  if (!current) return null;

  const merged = { ...current.state, ...(stateMerge ?? {}) } as T;
  const now = nowIso();
  const expires = new Date(Date.now() + FLOW_TTL_SECONDS * 1000).toISOString();

  // Only overwrite prompt_msg_id when explicitly provided (undefined
  // means "leave alone"; null means "clear").
  const nextPromptMsgId = promptMsgId === undefined
    ? current.prompt_msg_id
    : promptMsgId;

  await db.prepare(
    `UPDATE pending_flows
        SET step = ?2, state = ?3, prompt_msg_id = ?4,
            updated_at = ?5, expires_at = ?6
      WHERE user_id = ?1`,
  ).bind(userId, step, JSON.stringify(merged), nextPromptMsgId, now, expires).run();

  return {
    user_id: userId,
    flow: current.flow,
    step,
    state: merged,
    chat_id: current.chat_id,
    prompt_msg_id: nextPromptMsgId,
  };
}

/** Delete a user's flow row. Safe to call when none exists. */
export async function clearFlow(db: D1Database, userId: number): Promise<void> {
  await db.prepare(
    `DELETE FROM pending_flows WHERE user_id = ?1`,
  ).bind(userId).run();
}

/** Housekeeping — best-effort cleanup, mirrors purgeExpiredConfirmations. */
export async function purgeExpiredFlows(db: D1Database): Promise<number> {
  const res = await db.prepare(
    `DELETE FROM pending_flows WHERE expires_at < ?1`,
  ).bind(nowIso()).run();
  return res.meta?.changes ?? 0;
}
