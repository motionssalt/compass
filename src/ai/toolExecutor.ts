// Bridges Gemini function calls to actual D1 operations.

import type { Env } from '../types/env';
import type { RecurrenceRule } from '../types/task';
import {
  createTask, updateTaskStatus, cancelTask, listTasksByFilter,
  editTask, deleteTask,
} from '../db/tasks';
import { getUserTimezone } from '../db/users';
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
      case 'create_task': return await handleCreate(env, userId, call.args);
      case 'update_task_status': return await handleUpdateStatus(env, userId, call.args);
      case 'cancel_task': return await handleCancel(env, userId, call.args);
      case 'list_tasks': return await handleList(env, userId, call.args);
      case 'edit_task': return await handleEdit(env, userId, call.args);
      case 'delete_task': return await handleDelete(env, userId, call.args);
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
// individual handlers
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
