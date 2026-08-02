import type { Task, TaskStatus } from '../types/task';
import type { RecurrenceRule, SchedulingConstraint } from '../types/shared';
import { nowIso, localWeekday, localDateString } from '../utils/time';
import {
  normalisePriorityToInt,
  DEFAULT_PRIORITY_INT,
} from '../utils/priority';
import {
  parseScheduleConstraint,
  stringifyScheduleConstraint,
  safeParseStoredConstraint,
  cycleKeyForNow,
} from '../utils/scheduleConstraint';

// ---------------------------------------------------------------
// Read
// ---------------------------------------------------------------

export async function listOpenTasks(db: D1Database, userId: number): Promise<Task[]> {
  // "Open" here means "still on the user's list": pending, in_progress,
  // AND paused. A paused task is deliberately parked by the user — it
  // must stay visible in every listing / picker /today /alltasks, but
  // the free-time nudger (utils/nudgeScoring.ts) and the "are you busy
  // right now?" check (utils/freeWindow.ts) both inspect status by
  // EXACT value and gate only on 'pending' / 'in_progress'
  // respectively. Widening the listing here does NOT, therefore,
  // accidentally cause the nudger to surface a paused row.
  const { results } = await db.prepare(
    `SELECT * FROM tasks
      WHERE user_id = ?1
        AND status IN ('pending','in_progress','paused')
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'pending'     THEN 1
          WHEN 'paused'      THEN 2
          ELSE 3 END,
        priority ASC,
        created_at ASC`,
  ).bind(userId).all<Task>();
  return results ?? [];
}

/**
 * All open (pending/in_progress/paused) tasks regardless of scheduled date.
 *
 * This is deliberately a thin wrapper around the same base query
 * listOpenTasks uses — the /alltasks command and its menu button
 * want "every open task" (today + non-today combined), not a forked
 * ordering rule. Recurring tasks appear ONCE here (as the single
 * ongoing row they are); we do NOT expand them into future
 * occurrences.
 */
export async function listAllOpenTasks(db: D1Database, userId: number): Promise<Task[]> {
  return listOpenTasks(db, userId);
}

export async function listTasksByFilter(
  db: D1Database,
  userId: number,
  filter: 'pending' | 'in_progress' | 'paused' | 'done' | 'cancelled' | 'today' | 'recurring',
  timezone: string,
): Promise<Task[]> {
  if (filter === 'recurring') {
    const { results } = await db.prepare(
      `SELECT * FROM tasks
        WHERE user_id = ?1 AND is_recurring = 1
        ORDER BY priority ASC, title ASC`,
    ).bind(userId).all<Task>();
    return results ?? [];
  }

  if (filter === 'today') {
    // "Today" = open tasks that are either
    //   * recurring and due today (daily, or weekly matching today's weekday), or
    //   * scheduled for today — accepting the literal word "today", or
    //     an ISO date whose local calendar date equals today's, or
    //   * unscheduled (scheduled_for is null/empty) — a freshly added
    //     open task with no explicit schedule belongs on today's list;
    //     otherwise newly created tasks never surface in /today.
    // Paused tasks are included so the user can still see them in /today
    // (a paused task is still on the list), prefixed with ⏸.
    const now = new Date();
    const weekday = localWeekday(now, timezone);
    const todayLocal = localDateString(now, timezone);
    const openTasks = await listOpenTasks(db, userId);
    return openTasks.filter((t) => {
      if (t.is_recurring) {
        if (!t.recurrence_rule) return true;
        try {
          const rule = JSON.parse(t.recurrence_rule) as RecurrenceRule;
          if (rule.freq === 'daily') return true;
          if (rule.freq === 'weekly' && rule.days?.includes(weekday)) return true;
        } catch { /* fall through */ }
        return false;
      }
      const sched = t.scheduled_for?.trim();
      if (!sched) return true;
      if (/today/i.test(sched)) return true;
      // ISO datetime / date prefix match against today's local date.
      const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(sched);
      if (isoDate && isoDate[1] === todayLocal) return true;
      return false;
    });
  }

  const { results } = await db.prepare(
    `SELECT * FROM tasks
      WHERE user_id = ?1 AND status = ?2
      ORDER BY priority ASC, created_at DESC
      LIMIT 100`,
  ).bind(userId, filter).all<Task>();
  return results ?? [];
}

export async function getTaskById(
  db: D1Database, userId: number, id: number,
): Promise<Task | null> {
  const row = await db.prepare(
    `SELECT * FROM tasks WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId).first<Task>();
  return row ?? null;
}

// ---------------------------------------------------------------
// Relationship helpers (dependencies + parent/subtask)
// ---------------------------------------------------------------

/**
 * Thrown by updateTaskStatus when the caller asks to mark a parent
 * task 'done' while any subtask is still open. Named subclass rather
 * than a generic Error so upstream handlers (AI tool executor, direct
 * slash commands, button flow) can distinguish it from an incidental
 * D1 failure and surface a friendly, tailored message. The user-
 * visible copy each caller shows is decided in the caller — this
 * class just carries the machine-readable payload.
 */
export class ParentHasOpenSubtasksError extends Error {
  constructor(
    public readonly parentId: number,
    public readonly openSubtaskIds: number[],
  ) {
    super(
      `Task #${parentId} still has ${openSubtaskIds.length} open subtask`
      + `${openSubtaskIds.length === 1 ? '' : 's'} `
      + `(${openSubtaskIds.map((n) => `#${n}`).join(', ')}).`,
    );
    this.name = 'ParentHasOpenSubtasksError';
  }
}

/**
 * List subtasks (direct children only, one level) of `parentId` for
 * `userId`. Ordered the same way listOpenTasks orders open rows so
 * subtask groupings render consistently.
 *
 * Deliberately user-scoped even though every caller already has the
 * parent's user_id — the same defensive pattern every other single-
 * scope read in this module uses.
 */
export async function listSubtasks(
  db: D1Database, userId: number, parentId: number,
): Promise<Task[]> {
  const { results } = await db.prepare(
    `SELECT * FROM tasks
      WHERE user_id = ?1 AND parent_task_id = ?2
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'pending'     THEN 1
          WHEN 'paused'      THEN 2
          WHEN 'done'        THEN 3
          WHEN 'cancelled'   THEN 4
          ELSE 5 END,
        priority ASC,
        created_at ASC`,
  ).bind(userId, parentId).all<Task>();
  return results ?? [];
}

/**
 * Return the OPEN subtask ids for `parentId`. "Open" is the same set
 * listOpenTasks uses — pending / in_progress / paused. Used by the
 * updateTaskStatus gate that refuses to mark a parent done while any
 * subtask is still on the list.
 */
export async function listOpenSubtaskIds(
  db: D1Database, userId: number, parentId: number,
): Promise<number[]> {
  const { results } = await db.prepare(
    `SELECT id FROM tasks
      WHERE user_id = ?1
        AND parent_task_id = ?2
        AND status IN ('pending','in_progress','paused')`,
  ).bind(userId, parentId).all<{ id: number }>();
  return (results ?? []).map((r) => r.id);
}

// ---------------------------------------------------------------
// Write
// ---------------------------------------------------------------

export interface CreateTaskInput {
  user_id: number;
  title: string;
  /** Letter grade (A+..E-) or a normalised integer. See utils/priority.ts. */
  priority?: string | number;
  context_note?: string | null;
  scheduled_for?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
  /** Optional rough duration in minutes. */
  time_estimate_minutes?: number | null;
  /**
   * Optional structured scheduling constraint. Accepts a parsed
   * object OR a JSON string OR null. Validated via
   * parseScheduleConstraint on the way in; a bad shape throws so the
   * caller sees the error rather than silently persisting garbage.
   */
  schedule_constraint?: SchedulingConstraint | string | null;
  /**
   * Optional soft dependency — the id of another task this row
   * depends on. Purely informational (not blocking). Must reference
   * a task belonging to `user_id`; must not reference the row being
   * created (self-reference is refused). null / undefined = no link.
   */
  depends_on_task_id?: number | null;
  /**
   * Optional parent pointer (this row becomes a subtask of it).
   * Same user-scoping and self-reference rules as depends_on.
   * Enforcement of the "cannot mark parent done with open subtasks"
   * gate lives in updateTaskStatus — create/edit never block on it.
   */
  parent_task_id?: number | null;
}

export async function createTask(db: D1Database, input: CreateTaskInput): Promise<Task> {
  const now = nowIso();
  const priority = input.priority === undefined
    ? DEFAULT_PRIORITY_INT
    : normalisePriorityToInt(input.priority);
  const ruleJson = input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : null;
  const timeEstimate = normaliseTimeEstimate(input.time_estimate_minutes);
  const constraintJson = normaliseConstraintForWrite(input.schedule_constraint);

  // Relationship pointers. Validated up front against the SAME user
  // so a stray cross-user id can't sneak in; a self-reference on
  // create is only possible via a stale AI hallucination (the row
  // has no id yet), so we skip that check here and let editTask
  // catch it on later edits.
  const dependsOn = await validateRelationTarget(
    db, input.user_id, input.depends_on_task_id, null, 'depends_on_task_id',
  );
  const parentId = await validateRelationTarget(
    db, input.user_id, input.parent_task_id, null, 'parent_task_id',
  );

  const result = await db.prepare(
    `INSERT INTO tasks
       (user_id, title, status, priority, context_note, scheduled_for,
        is_recurring, recurrence_rule, time_estimate_minutes,
        schedule_constraint, missed_cycle_key,
        depends_on_task_id, parent_task_id,
        created_at, updated_at)
     VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?12)
     RETURNING *`,
  ).bind(
    input.user_id,
    input.title.trim(),
    priority,
    input.context_note ?? null,
    input.scheduled_for ?? null,
    input.is_recurring ? 1 : 0,
    ruleJson,
    timeEstimate,
    constraintJson,
    dependsOn,
    parentId,
    now,
  ).first<Task>();

  if (!result) throw new Error('Failed to insert task');
  return result;
}

export async function updateTaskStatus(
  db: D1Database, userId: number, id: number, status: TaskStatus,
  extras?: { cancel_reason?: string | null },
): Promise<Task | null> {
  const now = nowIso();
  const completedAt = status === 'done' ? now : null;
  const cancelReason = status === 'cancelled' ? extras?.cancel_reason ?? null : null;

  // Parent/subtask gate.
  //
  // The parent-task rule is HARD: a task that has any open subtask
  // (pending / in_progress / paused) cannot transition to 'done'.
  // We enforce it here, in the single write path every caller — AI
  // tool executor, direct slash command, button flow — already
  // funnels through, so no path can accidentally bypass it.
  //
  // Only 'done' is gated: cancelling a parent while subtasks remain
  // is legitimate ("drop this whole thing"), and pause/resume don't
  // claim completion. Cancellation of a parent does NOT recursively
  // cancel its subtasks — that would be surprising in a way "drop
  // the umbrella" doesn't imply, and users can cancel each child
  // themselves if that's what they want.
  if (status === 'done') {
    const openChildren = await listOpenSubtaskIds(db, userId, id);
    if (openChildren.length > 0) {
      throw new ParentHasOpenSubtasksError(id, openChildren);
    }
  }

  // Completing (or cancelling) a task clears any lingering
  // missed_cycle_key: whatever cycle was flagged as missed is
  // resolved by the user acting on it, and the row should not
  // enter its next cycle already "missed".
  const clearMissed = status === 'done' || status === 'cancelled';

  const row = await db.prepare(
    `UPDATE tasks
        SET status = ?3,
            last_completed_at = COALESCE(?4, last_completed_at),
            cancel_reason = CASE WHEN ?3 = 'cancelled' THEN ?5 ELSE cancel_reason END,
            missed_cycle_key = CASE WHEN ?7 = 1 THEN NULL ELSE missed_cycle_key END,
            updated_at = ?6
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(id, userId, status, completedAt, cancelReason, now, clearMissed ? 1 : 0).first<Task>();

  return row ?? null;
}

export async function cancelTask(
  db: D1Database, userId: number, id: number, reason?: string | null,
): Promise<Task | null> {
  return updateTaskStatus(db, userId, id, 'cancelled', { cancel_reason: reason ?? null });
}

export interface EditFields {
  title?: string;
  /** Letter grade (A+..E-) or a normalised integer. */
  priority?: string | number;
  context_note?: string | null;
  scheduled_for?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
  status?: TaskStatus;
  time_estimate_minutes?: number | null;
  /**
   * Structured scheduling constraint. Passing `undefined` leaves the
   * existing value untouched; passing `null` clears it. Accepts a
   * parsed object or a JSON string on the way in — validated the
   * same way create does.
   */
  schedule_constraint?: SchedulingConstraint | string | null;
  /**
   * Soft dependency pointer. `undefined` leaves it alone; `null`
   * clears it; a number sets/replaces it. Same user-scope and self-
   * reference validation as the create path.
   */
  depends_on_task_id?: number | null;
  /**
   * Parent pointer. Same `undefined` = leave alone, `null` = clear,
   * number = set semantics as depends_on_task_id above. Setting
   * this on a row that already has open subtasks is legal — a task
   * can be both a parent AND a subtask of another (a grandchild
   * relationship). We DO refuse a direct self-parenting on edit
   * (`parent_task_id = id`); deeper cycle detection is deferred to
   * a future pass because it never comes up organically — users
   * don't ask to point a task at itself through a chain by hand.
   */
  parent_task_id?: number | null;
}

export async function editTask(
  db: D1Database, userId: number, id: number, fields: EditFields,
): Promise<Task | null> {
  const existing = await getTaskById(db, userId, id);
  if (!existing) return null;

  // Same status gate updateTaskStatus applies — if this edit is
  // trying to slip a parent into 'done' via the fields.status path
  // (the AI's edit_task tool, /edittask status=done, the button
  // flow's status picker) it must still respect the subtask rule.
  if (fields.status === 'done') {
    const openChildren = await listOpenSubtaskIds(db, userId, id);
    if (openChildren.length > 0) {
      throw new ParentHasOpenSubtasksError(id, openChildren);
    }
  }

  // Relationship-pointer patches. `undefined` = leave alone, `null`
  // = clear. Validation goes through the same helper createTask
  // uses, plus the extra self-reference check that only becomes
  // possible once the row has an id.
  const dependsOn = fields.depends_on_task_id === undefined
    ? existing.depends_on_task_id
    : await validateRelationTarget(db, userId, fields.depends_on_task_id, id, 'depends_on_task_id');
  const parentId = fields.parent_task_id === undefined
    ? existing.parent_task_id
    : await validateRelationTarget(db, userId, fields.parent_task_id, id, 'parent_task_id');

  const merged = {
    title: fields.title ?? existing.title,
    priority: fields.priority !== undefined
      ? normalisePriorityToInt(fields.priority)
      : existing.priority,
    context_note: fields.context_note !== undefined ? fields.context_note : existing.context_note,
    scheduled_for: fields.scheduled_for !== undefined ? fields.scheduled_for : existing.scheduled_for,
    is_recurring: fields.is_recurring !== undefined
      ? (fields.is_recurring ? 1 : 0)
      : existing.is_recurring,
    recurrence_rule: fields.recurrence_rule !== undefined
      ? (fields.recurrence_rule ? JSON.stringify(fields.recurrence_rule) : null)
      : existing.recurrence_rule,
    status: fields.status ?? existing.status,
    time_estimate_minutes: fields.time_estimate_minutes !== undefined
      ? normaliseTimeEstimate(fields.time_estimate_minutes)
      : existing.time_estimate_minutes,
    schedule_constraint: fields.schedule_constraint !== undefined
      ? normaliseConstraintForWrite(fields.schedule_constraint)
      : existing.schedule_constraint,
    depends_on_task_id: dependsOn,
    parent_task_id: parentId,
    // Rewriting the constraint or the recurrence rule invalidates
    // any previously-recorded missed cycle: the definition of the
    // window it belonged to has changed. Editing anything else
    // leaves missed_cycle_key alone.
    missed_cycle_key:
      fields.schedule_constraint !== undefined || fields.recurrence_rule !== undefined
        ? null
        : existing.missed_cycle_key,
  };

  const row = await db.prepare(
    `UPDATE tasks
        SET title = ?3, priority = ?4, context_note = ?5, scheduled_for = ?6,
            is_recurring = ?7, recurrence_rule = ?8, status = ?9,
            time_estimate_minutes = ?10,
            schedule_constraint = ?11,
            missed_cycle_key = ?12,
            depends_on_task_id = ?14,
            parent_task_id = ?15,
            updated_at = ?13
      WHERE id = ?1 AND user_id = ?2
      RETURNING *`,
  ).bind(
    id, userId,
    merged.title, merged.priority, merged.context_note, merged.scheduled_for,
    merged.is_recurring, merged.recurrence_rule, merged.status,
    merged.time_estimate_minutes,
    merged.schedule_constraint,
    merged.missed_cycle_key,
    nowIso(),
    merged.depends_on_task_id,
    merged.parent_task_id,
  ).first<Task>();

  return row ?? null;
}

export async function deleteTask(
  db: D1Database, userId: number, id: number,
): Promise<boolean> {
  const res = await db.prepare(
    `DELETE FROM tasks WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------
// Missed-cycle bookkeeping
// ---------------------------------------------------------------

/**
 * Stamp a missed-cycle key onto a task. Called from the nudge cron
 * when it observes that a recurring task's constraint window has
 * closed for the current cycle with the task still open.
 *
 * The stamp is idempotent — writing the same key twice is a no-op —
 * and the query is user-scoped even though callers already have the
 * task id, matching the pattern every other single-row write in
 * this module uses.
 */
export async function markMissedCycle(
  db: D1Database, userId: number, taskId: number, cycleKey: string,
): Promise<void> {
  await db.prepare(
    `UPDATE tasks
        SET missed_cycle_key = ?3,
            updated_at = ?4
      WHERE id = ?1 AND user_id = ?2
        AND (missed_cycle_key IS NULL OR missed_cycle_key != ?3)`,
  ).bind(taskId, userId, cycleKey, nowIso()).run();
}

/**
 * Clear a stale missed_cycle_key. Called by the nudge cron when it
 * notices that a task's stored cycle key no longer matches the
 * current cycle — meaning the row has rolled into a new cycle and
 * the old "missed" flag has served its purpose.
 *
 * Deliberately narrow: only clears when the stored key EQUALS the
 * `staleKey` we saw, so a concurrent stamp between the read and
 * this write doesn't get clobbered.
 */
export async function clearMissedCycleIfKeyMatches(
  db: D1Database, userId: number, taskId: number, staleKey: string,
): Promise<void> {
  await db.prepare(
    `UPDATE tasks
        SET missed_cycle_key = NULL,
            updated_at = ?4
      WHERE id = ?1 AND user_id = ?2
        AND missed_cycle_key = ?3`,
  ).bind(taskId, userId, staleKey, nowIso()).run();
}

// ---------------------------------------------------------------
// Recurring task reset (cron)
// ---------------------------------------------------------------

/**
 * For every recurring task whose rule fires today, if its current
 * status is done/cancelled (and only those), flip it back to pending
 * so it shows up again in "what should I do now?".
 *
 * Deliberately does NOT touch paused rows here: a paused task is a
 * user choice, not a completion. The cron must not silently unpause
 * a task the user is parking.
 *
 * Also deliberately does NOT read or write missed_cycle_key. A
 * missed cycle is a nudge-eligibility signal orthogonal to status;
 * stale keys are cleared by the nudge cron's own housekeeping (see
 * clearMissedCycleIfKeyMatches) so a task's next occurrence is
 * NEVER affected by whether the previous one was missed.
 */
export async function resetRecurringForDay(
  db: D1Database, timezone: string,
): Promise<number> {
  const weekday = localWeekday(new Date(), timezone);
  const { results } = await db.prepare(
    `SELECT * FROM tasks WHERE is_recurring = 1`,
  ).all<Task>();

  let resetCount = 0;
  for (const t of results ?? []) {
    let fires = true;
    if (t.recurrence_rule) {
      try {
        const rule = JSON.parse(t.recurrence_rule) as RecurrenceRule;
        if (rule.freq === 'weekly') {
          fires = !!rule.days?.includes(weekday);
        }
      } catch { /* keep fires = true */ }
    }
    if (!fires) continue;
    if (t.status === 'done' || t.status === 'cancelled') {
      await db.prepare(
        `UPDATE tasks SET status = 'pending', updated_at = ?2 WHERE id = ?1`,
      ).bind(t.id, nowIso()).run();
      resetCount++;
    }
  }
  return resetCount;
}

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

function normaliseTimeEstimate(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n <= 0) return null;
  // A soft upper cap so a stray "1440000" doesn't land in the DB.
  return Math.min(n, 60 * 24 * 30);
}

/**
 * Shared user-scoped validator for both relationship-pointer columns
 * (depends_on_task_id, parent_task_id). Returns the id to store or
 * null when the caller is clearing the pointer.
 *
 *   - `null` or `undefined` -> null (clear / leave-blank).
 *   - A number that IS `selfId` -> refused (a task can't point at
 *     itself).
 *   - A number pointing at a row that doesn't exist or belongs to
 *     another user -> refused. The user-scope check is what keeps
 *     cross-user references from ever landing in the DB; the
 *     schema's REFERENCES clause alone wouldn't catch that.
 *
 * Kept file-local because the two columns are the only callers and
 * the validation intentionally lives right next to the write path
 * it protects.
 */
async function validateRelationTarget(
  db: D1Database,
  userId: number,
  targetId: number | null | undefined,
  selfId: number | null,
  fieldName: string,
): Promise<number | null> {
  if (targetId === null || targetId === undefined) return null;
  if (!Number.isFinite(targetId) || targetId <= 0) {
    throw new Error(`${fieldName}: expected a positive task id, got ${targetId}`);
  }
  if (selfId !== null && targetId === selfId) {
    throw new Error(`${fieldName}: a task cannot reference itself (#${selfId})`);
  }
  const row = await db.prepare(
    `SELECT id FROM tasks WHERE id = ?1 AND user_id = ?2`,
  ).bind(targetId, userId).first<{ id: number }>();
  if (!row) {
    throw new Error(`${fieldName}: no task #${targetId} on your list`);
  }
  return targetId;
}

/**
 * Coerce whatever the caller handed us into the exact TEXT (JSON or
 * NULL) shape the schedule_constraint column stores. Validation is
 * shared with the AI-tool path and the direct-command path via
 * parseScheduleConstraint — a bad shape throws so the invalid write
 * surfaces immediately.
 */
function normaliseConstraintForWrite(
  v: SchedulingConstraint | string | null | undefined,
): string | null {
  if (v === undefined || v === null) return null;
  const parsed = parseScheduleConstraint(
    typeof v === 'string' ? v : (v as unknown as Record<string, unknown>),
  );
  if (!parsed.ok) {
    throw new Error(`Invalid schedule_constraint: ${parsed.error}`);
  }
  return stringifyScheduleConstraint(parsed.constraint);
}

// Re-exports so callers doing "import { ... } from '../db/tasks'"
// can pick up the constraint helpers alongside the CRUD they were
// already reaching for. Matches how RecurrenceRule is re-exported
// from src/types/task.ts.
export {
  parseScheduleConstraint,
  safeParseStoredConstraint,
  cycleKeyForNow,
};
