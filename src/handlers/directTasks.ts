// Direct (non-AI) task commands.
//
// These slash-command handlers deliberately skip Gemini so cheap,
// high-frequency task edits don't burn API quota. Every write path
// here goes through the SAME src/db/tasks.ts functions the AI tools
// call — no forked logic — so an /addtask row and a create_task
// tool-call end up identical in the DB.
//
// Batch entry syntax (one task per line):
//
//     Title text | priority=B+ | dur=45 | when=morning | note=foo
//
// Only the title is required. Recognised tags (case-insensitive,
// order irrelevant, `|` separates them from each other and from the
// title):
//
//   priority=  or  p=      letter grade A+..E-
//   dur=       or  time=  or  est=      minutes (positive integer)
//   when=      or  sched=  or  at=      loose text or ISO datetime
//   note=      or  ctx=                  free-text context
//
// A `#` at the start of a line is a comment. Blank lines are
// skipped. Any line that starts with `-` or `•` has that bullet
// stripped so pasted bulleted lists just work.

import type { Env } from '../types/env';
import type { RecurrenceRule } from '../types/shared';
import type { Task } from '../types/task';
import {
  createTask, editTask, getTaskById, listOpenTasks,
  type CreateTaskInput, type EditFields,
} from '../db/tasks';
import { sendMessage } from '../services/telegram';
import {
  isValidPriorityLetter, priorityIntToLetter, DEFAULT_PRIORITY_INT,
  comparePriorityInt,
} from '../utils/priority';
import { isFlexibleTask } from '../utils/nudgeScoring';

// ---------------------------------------------------------------
// Public entry points — one per slash command.
//
// Each returns the reply text so the webhook can chunk / log it in
// the same way it handles the existing /balance et al.
// ---------------------------------------------------------------

export async function cmdAddTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  if (!argStr.trim()) {
    return (
      `Usage: /addtask <title> [| priority=B+] [| dur=45] [| when=morning] [| note=...]\n` +
      `Example: /addtask Draft the report | p=A | dur=90 | when=this afternoon`
    );
  }
  const parsed = parseTaskLine(argStr);
  if (!parsed.ok) return `Couldn't add that: ${parsed.error}`;

  const task = await createTask(env.DB, {
    user_id: userId,
    ...parsed.input,
  });
  return `Added: ${formatTaskLine(task)}`;
}

export async function cmdAddBatch(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  if (!argStr.trim()) {
    return (
      `Usage: /addbatch — one task per line, same syntax as /addtask.\n\n` +
      `Example:\n` +
      `/addbatch\n` +
      `Draft report | p=A | dur=90\n` +
      `Reply to Sam | p=B+ | dur=10\n` +
      `- Fold laundry | p=C-`
    );
  }

  const lines = argStr.split(/\r?\n/);
  const created: Task[] = [];
  const errors: string[] = [];
  let lineNum = 0;

  for (const raw of lines) {
    lineNum++;
    const line = raw.replace(/^\s*[-•]\s+/, '').trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    const parsed = parseTaskLine(line);
    if (!parsed.ok) {
      errors.push(`  L${lineNum}: ${parsed.error}`);
      continue;
    }
    try {
      const task = await createTask(env.DB, {
        user_id: userId,
        ...parsed.input,
      });
      created.push(task);
    } catch (err) {
      errors.push(`  L${lineNum}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const parts: string[] = [];
  if (created.length > 0) {
    parts.push(`Added ${created.length} task${created.length === 1 ? '' : 's'}:`);
    for (const t of created) parts.push(formatTaskLine(t));
  } else {
    parts.push(`No tasks added.`);
  }
  if (errors.length > 0) {
    parts.push('');
    parts.push(`Skipped ${errors.length} line${errors.length === 1 ? '' : 's'}:`);
    parts.push(...errors);
  }
  return parts.join('\n');
}

export async function cmdEditTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  if (!argStr.trim()) {
    return (
      `Usage: /edittask <id> field=value [| field=value ...]\n` +
      `Fields: title, priority (A+..E-), dur (minutes), when, note, status (pending|in_progress|done|cancelled)\n` +
      `Example: /edittask 12 | p=A- | dur=30 | when=tonight`
    );
  }

  // Grab the leading id, everything after is the pipe-separated field
  // list (with an optional leading `|`).
  const m = /^\s*#?(\d+)\s*\|?\s*(.*)$/s.exec(argStr);
  if (!m) return `Couldn't read a task id from "${argStr.slice(0, 40)}".`;
  const id = parseInt(m[1], 10);
  const rest = m[2] ?? '';
  if (!Number.isFinite(id) || id <= 0) return `Invalid task id.`;

  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) return `No task #${id}.`;

  const parsed = parseEditFields(rest);
  if (!parsed.ok) return `Couldn't edit: ${parsed.error}`;
  if (Object.keys(parsed.fields).length === 0) {
    return `Nothing to change. Give me at least one field, e.g. "/edittask ${id} | p=A".`;
  }

  const updated = await editTask(env.DB, userId, id, parsed.fields);
  if (!updated) return `No task #${id}.`;
  return `Updated: ${formatTaskLine(updated)}`;
}

export async function cmdReviewFlexible(
  env: Env, userId: number,
): Promise<string> {
  const open = await listOpenTasks(env.DB, userId);
  const flexible = open
    .filter(isFlexibleTask)
    .sort((a, b) => {
      // Part-1 letter-grade sort: lower integer = higher priority.
      const p = comparePriorityInt(a.priority, b.priority);
      if (p !== 0) return p;
      return a.created_at.localeCompare(b.created_at);
    });

  if (flexible.length === 0) {
    return `No open flexible tasks. Everything on the list either has a hard time or is already in progress.`;
  }
  return `Flexible tasks (highest priority first):\n${flexible.map(formatTaskLine).join('\n')}`;
}

// ---------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------

interface ParseTaskOk {
  ok: true;
  input: Omit<CreateTaskInput, 'user_id'>;
}
interface ParseFail { ok: false; error: string }

function parseTaskLine(line: string): ParseTaskOk | ParseFail {
  const segments = line.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, error: 'empty' };

  const title = segments[0];
  if (!title) return { ok: false, error: 'title is required' };

  const tags = segments.slice(1);
  const parsedTags = parseTagList(tags);
  if (!parsedTags.ok) return parsedTags;

  const input: Omit<CreateTaskInput, 'user_id'> = { title };
  if (parsedTags.fields.priority !== undefined) input.priority = parsedTags.fields.priority;
  if (parsedTags.fields.time_estimate_minutes !== undefined) {
    input.time_estimate_minutes = parsedTags.fields.time_estimate_minutes;
  }
  if (parsedTags.fields.scheduled_for !== undefined) {
    input.scheduled_for = parsedTags.fields.scheduled_for;
  }
  if (parsedTags.fields.context_note !== undefined) {
    input.context_note = parsedTags.fields.context_note;
  }
  return { ok: true, input };
}

interface ParseEditOk { ok: true; fields: EditFields }
function parseEditFields(rest: string): ParseEditOk | ParseFail {
  const segments = rest.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  const parsedTags = parseTagList(segments, /*allowStatus*/ true, /*allowTitle*/ true);
  if (!parsedTags.ok) return parsedTags;
  const fields: EditFields = {};
  if (parsedTags.fields.title !== undefined) fields.title = parsedTags.fields.title;
  if (parsedTags.fields.priority !== undefined) fields.priority = parsedTags.fields.priority;
  if (parsedTags.fields.time_estimate_minutes !== undefined) {
    fields.time_estimate_minutes = parsedTags.fields.time_estimate_minutes;
  }
  if (parsedTags.fields.scheduled_for !== undefined) {
    fields.scheduled_for = parsedTags.fields.scheduled_for;
  }
  if (parsedTags.fields.context_note !== undefined) {
    fields.context_note = parsedTags.fields.context_note;
  }
  if (parsedTags.fields.status !== undefined) fields.status = parsedTags.fields.status;
  return { ok: true, fields };
}

interface ParsedTagFields {
  title?: string;
  priority?: string;
  time_estimate_minutes?: number | null;
  scheduled_for?: string | null;
  context_note?: string | null;
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled';
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
}
interface ParseTagsOk { ok: true; fields: ParsedTagFields }

function parseTagList(
  tags: string[],
  allowStatus = false,
  allowTitle = false,
): ParseTagsOk | ParseFail {
  const fields: ParsedTagFields = {};
  for (const tag of tags) {
    const eq = tag.indexOf('=');
    if (eq < 0) {
      return { ok: false, error: `expected key=value, got "${tag}"` };
    }
    const key = tag.slice(0, eq).trim().toLowerCase();
    const value = tag.slice(eq + 1).trim();
    if (!value) return { ok: false, error: `empty value for "${key}"` };

    switch (key) {
      case 'title':
        if (!allowTitle) return { ok: false, error: `title is set from the first segment, not a tag` };
        fields.title = value;
        break;
      case 'p':
      case 'pr':
      case 'priority': {
        if (!isValidPriorityLetter(value)) {
          return { ok: false, error: `priority must be a letter grade A+..E-, got "${value}"` };
        }
        fields.priority = value.toUpperCase();
        break;
      }
      case 'dur':
      case 'duration':
      case 'time':
      case 'est':
      case 'estimate': {
        const n = parseDurationMinutes(value);
        if (n === null) return { ok: false, error: `duration must be minutes (e.g. 45, 1h, 90m), got "${value}"` };
        fields.time_estimate_minutes = n;
        break;
      }
      case 'when':
      case 'sched':
      case 'scheduled':
      case 'at': {
        // Loose text passthrough — matches how scheduled_for is
        // stored throughout the codebase.
        fields.scheduled_for = value;
        break;
      }
      case 'note':
      case 'ctx':
      case 'context': {
        fields.context_note = value;
        break;
      }
      case 'status': {
        if (!allowStatus) return { ok: false, error: `status not settable here` };
        const s = value.toLowerCase();
        if (!['pending', 'in_progress', 'done', 'cancelled'].includes(s)) {
          return { ok: false, error: `status must be one of pending|in_progress|done|cancelled` };
        }
        fields.status = s as ParsedTagFields['status'];
        break;
      }
      default:
        return { ok: false, error: `unknown tag "${key}"` };
    }
  }
  return { ok: true, fields };
}

/**
 * Parse a duration argument. Accepts:
 *   "45", "45m", "45min"  -> 45
 *   "1h", "1.5h"          -> 60, 90
 *   "1h30m", "1h 30m"     -> 90
 */
function parseDurationMinutes(v: string): number | null {
  const cleaned = v.trim().toLowerCase().replace(/\s+/g, '');
  if (!cleaned) return null;

  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const n = parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (/^\d+(\.\d+)?m(in)?$/.test(cleaned)) {
    const n = parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (/^\d+(\.\d+)?h$/.test(cleaned)) {
    const n = parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : null;
  }
  const hm = /^(\d+)h(\d+)m?$/.exec(cleaned);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (Number.isFinite(h) && Number.isFinite(m) && (h > 0 || m > 0)) {
      return h * 60 + m;
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------

function formatTaskLine(t: Task): string {
  const bits = [`#${t.id} ${t.title}`];
  if (t.priority && t.priority !== DEFAULT_PRIORITY_INT) {
    bits.push(`(${priorityIntToLetter(t.priority)})`);
  }
  if (t.time_estimate_minutes && t.time_estimate_minutes > 0) {
    bits.push(`~${t.time_estimate_minutes}min`);
  }
  if (t.scheduled_for) bits.push(`— ${t.scheduled_for}`);
  if (t.status !== 'pending') bits.push(`[${t.status}]`);
  return `• ${bits.join(' ')}`;
}

// ---------------------------------------------------------------
// Helper: also used by webhook to make sure sending outbound
// nudges never causes an unhandled reject.
// ---------------------------------------------------------------

export async function safeSend(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(env, chatId, text);
  } catch {
    /* logged upstream */
  }
}
