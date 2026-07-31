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
//     Title text | priority=B+ | dur=45 | when=morning | note=foo | constraint=days:mon,wed;time:07:00-08:00
//
// Only the title is required. Recognised tags (case-insensitive,
// order irrelevant, `|` separates them from each other and from the
// title):
//
//   priority=  or  p=      letter grade A+..E-
//   dur=       or  time=  or  est=      minutes (positive integer)
//   when=      or  sched=  or  at=      loose text or ISO datetime
//   note=      or  ctx=                  free-text context
//   constraint= or window= or c=        scheduling constraint (see below)
//
// A `#` at the start of a line is a comment. Blank lines are
// skipped. Any line that starts with `-` or `•` has that bullet
// stripped so pasted bulleted lists just work.
//
// Scheduling-constraint mini-syntax
// ---------------------------------
// The `constraint=` tag carries a compact, semicolon-separated
// sub-syntax that parses into the SAME SchedulingConstraint shape
// the AI tools and the button flow produce (see
// src/utils/scheduleConstraint.ts — one parser, no forks):
//
//   constraint=dates:2026-08-01..2026-08-15;days:mon,wed,fri;time:07:00-08:00
//
// Any subset is legal (all three sub-keys are independent). Either
// side of `dates:` may be a `-` or empty for an open-ended range.
// The literal values `none`, `clear`, `off`, or an empty value
// remove any existing constraint. On `/addtask` an omitted or empty
// `constraint=` means \"no constraint\" (the default).

import type { Env } from '../types/env';
import type { RecurrenceRule, SchedulingConstraint } from '../types/shared';
import type { Task, TaskStatus } from '../types/task';
import {
  createTask, editTask, getTaskById, listOpenTasks, updateTaskStatus,
  parseScheduleConstraint, safeParseStoredConstraint,
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
      `Usage: /addtask <title> [| priority=B+] [| dur=45] [| when=morning] [| note=...] [| constraint=days:mon,wed;time:07:00-08:00]\n` +
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
      `Fields: title, priority (A+..E-), dur (minutes), when, note, status (pending|in_progress|paused|done|cancelled), constraint (see /schedule)\n` +
      `Example: /edittask 12 | p=A- | dur=30 | when=tonight\n` +
      `Example: /edittask 12 | constraint=days:mon,wed,fri;time:07:00-08:00`
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

/**
 * /schedule <id> [constraint-parts...]
 *
 * Dedicated slash-command for the scheduling-constraint field. Takes
 * the SAME mini-syntax the `constraint=` tag on /addtask and /edittask
 * uses (semicolon- OR pipe-separated `key:value` pairs) but without the
 * outer `constraint=` wrapper — this is the whole command's purpose,
 * so the wrapper would just be noise.
 *
 * Examples:
 *   /schedule 12 days:mon,wed,fri; time:07:00-08:00
 *   /schedule 12 dates:2026-08-01..2026-08-15
 *   /schedule 12 clear
 *   /schedule 12                    (show current)
 *
 * Routes through the SAME editTask helper the AI's edit_task tool and
 * the button flow call. No forked logic; the field itself is validated
 * by parseScheduleConstraint just like every other write path.
 */
export async function cmdSchedule(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  if (!argStr.trim()) {
    return (
      `Usage: /schedule <id> [dates:YYYY-MM-DD..YYYY-MM-DD] [days:mon,wed,fri] [time:HH:MM-HH:MM]\n` +
      `       /schedule <id> clear     — remove any existing constraint\n` +
      `       /schedule <id>           — show the current constraint\n` +
      `Any subset is legal; all three sub-keys are independent of each\n` +
      `other AND of scheduled_for / recurrence. Either side of \`dates:\`\n` +
      `may be \`-\` or empty for an open-ended range.\n\n` +
      `Example: /schedule 12 days:mon,wed,fri; time:07:00-08:00\n` +
      `Example: /schedule 12 dates:2026-08-01..2026-08-15`
    );
  }

  // Parse "<id> <rest>" — the id is the first whitespace-separated
  // token; everything after is the constraint expression.
  const m = /^\s*#?(\d+)\s*(.*)$/s.exec(argStr);
  if (!m) return `Couldn't read a task id from "${argStr.slice(0, 40)}".`;
  const id = parseInt(m[1], 10);
  const rest = (m[2] ?? '').trim();
  if (!Number.isFinite(id) || id <= 0) return `Invalid task id.`;

  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) return `No task #${id}.`;

  // Bare "/schedule <id>" — show the current constraint.
  if (!rest) {
    const current = safeParseStoredConstraint(existing.schedule_constraint);
    const summary = formatConstraint(current);
    return (
      `#${id} ${existing.title}\n` +
      `Constraint: ${summary}\n\n` +
      `Change it with e.g. /schedule ${id} days:mon,wed,fri; time:07:00-08:00\n` +
      `Clear it with /schedule ${id} clear`
    );
  }

  const parsed = parseConstraintExpression(rest);
  if (!parsed.ok) return `Couldn't set constraint: ${parsed.error}`;

  const updated = await editTask(env.DB, userId, id, {
    schedule_constraint: parsed.value,
  });
  if (!updated) return `No task #${id}.`;

  const summary = formatConstraint(safeParseStoredConstraint(updated.schedule_constraint));
  return `Updated: ${formatTaskLine(updated)}\nConstraint: ${summary}`;
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
// Status-only direct commands.
//
// Thin wrappers around updateTaskStatus — same helper the AI's
// update_task_status / pause_task / resume_task tools, the
// /edittask status field, the status picker inside Edit Task, and
// the Start / Finish / Pause / Resume menu buttons all route
// through. No forked logic.
//
//   /pause      -> status='paused'      (parked; hidden from nudges)
//   /resume     -> status='pending'     (unpark; back into nudges)
//   /starttask  -> status='in_progress' (user is actively on it now)
//   /finishtask -> status='done'        (user finished it themselves)
//
// All four expect a single argument — the task id — mirroring the
// existing /deletetask <id> shape.
// ---------------------------------------------------------------

async function statusOnlyCommand(
  env: Env, userId: number, argStr: string,
  targetStatus: TaskStatus,
  usage: string,
  formatMsg: (task: Task) => string,
): Promise<string> {
  const idStr = argStr.trim().split(/\s+/)[0];
  const id = parseInt(idStr, 10);
  if (!idStr || !Number.isFinite(id) || id <= 0) {
    return usage;
  }
  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) return `No task #${id}.`;
  if (existing.status === targetStatus) {
    return `Task #${id} is already ${targetStatus}.`;
  }
  const updated = await updateTaskStatus(env.DB, userId, id, targetStatus);
  if (!updated) return `No task #${id}.`;
  return formatMsg(updated);
}

export async function cmdPauseTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  return statusOnlyCommand(env, userId, argStr, 'paused',
    `Usage: /pause <id>\nPauses a task — still visible in your lists, but skipped by the free-time nudger and by "what's active now".`,
    (t) => `Paused: ${formatTaskLine(t)}`,
  );
}

export async function cmdResumeTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  return statusOnlyCommand(env, userId, argStr, 'pending',
    `Usage: /resume <id>\nUnpauses a task — back in the pool for free-time nudges.`,
    (t) => `Resumed: ${formatTaskLine(t)}`,
  );
}

export async function cmdStartTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  return statusOnlyCommand(env, userId, argStr, 'in_progress',
    `Usage: /starttask <id>\nMarks a task as active right now.`,
    (t) => `Started: ${formatTaskLine(t)}`,
  );
}

export async function cmdFinishTask(
  env: Env, userId: number, argStr: string,
): Promise<string> {
  return statusOnlyCommand(env, userId, argStr, 'done',
    `Usage: /finishtask <id>\nMarks a task as done.`,
    (t) => `Finished: ${formatTaskLine(t)}`,
  );
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
  if (parsedTags.fields.schedule_constraint !== undefined) {
    input.schedule_constraint = parsedTags.fields.schedule_constraint;
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
  if (parsedTags.fields.schedule_constraint !== undefined) {
    fields.schedule_constraint = parsedTags.fields.schedule_constraint;
  }
  return { ok: true, fields };
}

interface ParsedTagFields {
  title?: string;
  priority?: string;
  time_estimate_minutes?: number | null;
  scheduled_for?: string | null;
  context_note?: string | null;
  status?: TaskStatus;
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
  /**
   * Parsed scheduling constraint. `undefined` means the tag wasn't
   * present (leave the field alone on edit; store null on create).
   * `null` means the tag WAS present with a `clear`/empty value —
   * clear any existing constraint.
   */
  schedule_constraint?: SchedulingConstraint | null;
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
    // Constraint tag is special: a bare `constraint=` (empty value)
    // is meaningful — it clears the field. Every other tag still
    // requires a non-empty value.
    const isConstraintKey =
      key === 'constraint' || key === 'window' || key === 'c';
    if (!value && !isConstraintKey) return { ok: false, error: `empty value for "${key}"` };

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
        if (!['pending', 'in_progress', 'paused', 'done', 'cancelled'].includes(s)) {
          return { ok: false, error: `status must be one of pending|in_progress|paused|done|cancelled` };
        }
        fields.status = s as ParsedTagFields['status'];
        break;
      }
      case 'constraint':
      case 'window':
      case 'c': {
        // Same mini-syntax as /schedule. Routes through the SAME
        // parseScheduleConstraint that validates every other write
        // path (AI tool, button flow) — no forked logic.
        const parsed = parseConstraintExpression(value);
        if (!parsed.ok) {
          return { ok: false, error: `constraint: ${parsed.error}` };
        }
        fields.schedule_constraint = parsed.value;
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
// Scheduling-constraint mini-syntax
// ---------------------------------------------------------------
//
// Compact, human-writable expression that maps to the same
// SchedulingConstraint shape the AI tools and the button flow
// produce. Everything eventually funnels through
// parseScheduleConstraint (src/utils/scheduleConstraint.ts) — this
// function only tokenises the string form, it never validates the
// semantic constraints itself.
//
// Grammar (informal):
//   expr    := "clear" | "none" | "off" | ""    -> null (clear)
//            | pair (SEP pair)*
//   pair    := "dates:" range
//            | "days:"  daycsv
//            | "time:"  timerange
//   SEP     := ";" or "|" or ","-around-a-pair-boundary
//
// The parser is intentionally forgiving: separators can be `;` or
// `|`, whitespace is tolerated everywhere, and sub-keys are
// case-insensitive.

export interface ParseConstraintOk {
  ok: true;
  value: SchedulingConstraint | null;
}

/**
 * Turn a mini-syntax expression into a validated SchedulingConstraint
 * (or null to clear). Exported so the button flow's free-text follow-
 * up paths can share the exact same parser.
 */
export function parseConstraintExpression(
  expr: string,
): ParseConstraintOk | ParseFail {
  const trimmed = (expr ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const lower = trimmed.toLowerCase();
  if (lower === 'clear' || lower === 'none' || lower === 'off' || lower === '-') {
    return { ok: true, value: null };
  }

  // Split on `;` or `|` — either separator works. Trim empties.
  const pairs = trimmed.split(/[;|]/).map((s) => s.trim()).filter((s) => s.length > 0);

  const obj: Record<string, unknown> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx < 0) {
      return { ok: false, error: `expected key:value in "${pair}"` };
    }
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();

    if (key === 'dates' || key === 'date' || key === 'range') {
      const range = parseDateRange(value);
      if (!range.ok) return range;
      obj.date_range = range.value;
    } else if (key === 'days' || key === 'day' || key === 'dow') {
      const days = parseDaysList(value);
      if (!days.ok) return days;
      obj.days_of_week = days.value;
    } else if (key === 'time' || key === 'window' || key === 'hours') {
      const tw = parseTimeWindow(value);
      if (!tw.ok) return tw;
      obj.time_of_day = tw.value;
    } else {
      return { ok: false, error: `unknown constraint key "${key}" (expected dates, days, or time)` };
    }
  }

  // Delegate final shape validation (empties, day dedup, min/max
  // ordering, HH:MM sanity, YYYY-MM-DD sanity) to the ONE place
  // that owns it.
  const parsed = parseScheduleConstraint(obj);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: parsed.constraint };
}

function parseDateRange(
  value: string,
): { ok: true; value: { start?: string; end?: string } } | ParseFail {
  // Accept "YYYY-MM-DD..YYYY-MM-DD" (canonical), or a single
  // "YYYY-MM-DD" (both sides equal to that), or "..YYYY-MM-DD" /
  // "YYYY-MM-DD.." for open-ended. Either side may be "-" for "no
  // bound on that side".
  const v = value.trim();
  if (!v) return { ok: false, error: `dates: empty range` };
  const parts = v.split('..');
  let startRaw: string;
  let endRaw: string;
  if (parts.length === 1) {
    startRaw = endRaw = parts[0];
  } else if (parts.length === 2) {
    startRaw = parts[0];
    endRaw = parts[1];
  } else {
    return { ok: false, error: `dates: expected YYYY-MM-DD..YYYY-MM-DD, got "${v}"` };
  }
  const range: { start?: string; end?: string } = {};
  const s = startRaw.trim();
  const e = endRaw.trim();
  if (s && s !== '-') range.start = s;
  if (e && e !== '-') range.end = e;
  return { ok: true, value: range };
}

function parseDaysList(
  value: string,
): { ok: true; value: string[] } | ParseFail {
  const raw = value.trim();
  if (!raw) return { ok: false, error: `days: empty` };
  // Accept comma OR whitespace as separator.
  const parts = raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return { ok: true, value: parts };
}

function parseTimeWindow(
  value: string,
): { ok: true; value: { start: string; end: string } } | ParseFail {
  const raw = value.trim();
  if (!raw) return { ok: false, error: `time: empty` };
  // Accept "HH:MM-HH:MM" or "HH:MM..HH:MM".
  const m = /^(\d{1,2}:\d{2})\s*(?:-|\.\.|to|—)\s*(\d{1,2}:\d{2})$/i.exec(raw);
  if (!m) {
    return { ok: false, error: `time: expected HH:MM-HH:MM, got "${raw}"` };
  }
  return { ok: true, value: { start: m[1], end: m[2] } };
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
  const constraint = safeParseStoredConstraint(t.schedule_constraint);
  if (constraint) {
    const summary = formatConstraintShort(constraint);
    if (summary) bits.push(`⟨${summary}⟩`);
  }
  if (t.status !== 'pending') bits.push(`[${t.status}]`);
  return `• ${bits.join(' ')}`;
}

/**
 * Compact single-line rendering of a constraint for inline task
 * listings. Empty when there's nothing to show. Same style as the
 * one in src/ai/systemPrompt.ts#summariseConstraint — kept here as
 * a peer rather than a shared helper because the two formats differ
 * on separators (this one uses commas/semicolons to fit the ⟨…⟩
 * bracket look, the AI one uses spaces to fit the bar-delimited
 * task line).
 */
function formatConstraintShort(c: SchedulingConstraint | null): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.date_range) {
    const { start, end } = c.date_range;
    if (start && end) parts.push(`${start}→${end}`);
    else if (start) parts.push(`from ${start}`);
    else if (end) parts.push(`until ${end}`);
  }
  if (c.days_of_week && c.days_of_week.length > 0) parts.push(c.days_of_week.join(','));
  if (c.time_of_day) parts.push(`${c.time_of_day.start}–${c.time_of_day.end}`);
  return parts.join('; ');
}

/**
 * Multi-line rendering for the /schedule show-current view. Says
 * "none" plainly when the field is null so a bare `/schedule <id>`
 * is a self-contained explanation.
 */
export function formatConstraint(c: SchedulingConstraint | null): string {
  if (!c) return 'none';
  const s = formatConstraintShort(c);
  return s || 'none';
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
