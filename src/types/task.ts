import type { RecurrenceRule } from './shared';

// 'paused' is the new "parked for now" state introduced alongside the
// /pause and /resume slash commands, the Pause / Resume menu buttons,
// and the AI's pause_task / resume_task tools. A paused task is still
// on the user's list — visible in every listing, every picker, every
// review — but is excluded from the free-time nudger and is not
// counted as the user's "active" task. See utils/nudgeScoring.ts and
// utils/freeWindow.ts for the two-and-a-half places where status is
// inspected by exact value, and src/db/tasks.ts for the listing query
// that decides which statuses count as "open".
export type TaskStatus = 'pending' | 'in_progress' | 'paused' | 'done' | 'cancelled';

export interface Task {
  id: number;
  user_id: number;
  title: string;
  status: TaskStatus;
  /**
   * Stored INTEGER 1..15 mapping to A+..E- via src/utils/priority.ts.
   * The letter grade is the only representation the AI and the user
   * ever see; this integer is an internal storage detail.
   */
  priority: number;
  context_note: string | null;
  scheduled_for: string | null;
  is_recurring: number;         // 0 or 1
  recurrence_rule: string | null; // JSON string
  last_completed_at: string | null;
  cancel_reason: string | null;
  /** Optional rough duration in minutes. Nullable — most tasks won't have one. */
  time_estimate_minutes: number | null;
  /**
   * ISO timestamp of the last time the free-window nudger surfaced
   * this task. Null before any nudge. Used purely as a fairness
   * signal by the nudge scorer — down-ranks a task that was just
   * shown so the user isn't shown the same one over and over.
   */
  last_nudged_at: string | null;
  /**
   * Structured scheduling-constraint JSON (see SchedulingConstraint
   * in ../types/shared.ts). Null when the task has no such
   * constraint — which is the default. Parse/validate/evaluate via
   * src/utils/scheduleConstraint.ts; no other module should touch
   * the raw string.
   */
  schedule_constraint: string | null;
  /**
   * Opaque cycle key stamped when the nudge cron observes that a
   * recurring task's constraint window has closed for the current
   * cycle with the task still open. Null means "no missed cycle
   * pending". Cleared on completion or when a fresh cycle opens.
   * Purely a nudge-eligibility signal — the daily reset in
   * src/db/tasks.resetRecurringForDay ignores it, so a missed cycle
   * NEVER affects the following occurrence.
   */
  missed_cycle_key: string | null;
  /**
   * Soft, INFORMATIONAL dependency pointer — "this task can't
   * reasonably start until #depends_on_task_id is done". Nothing in
   * the write path blocks on it; the AI's nudger and the system
   * prompt consult it to shape recommendations (avoid suggesting a
   * dependent while its dependency is still open) and task listings
   * surface it. See migrations/0009_task_relationships.sql.
   */
  depends_on_task_id: number | null;
  /**
   * Hard, blocking parent pointer for parent/subtask relationships.
   * When set, the row is a SUBTASK of #parent_task_id. A parent row
   * cannot transition to status='done' while any of its subtasks is
   * still open (pending / in_progress / paused) — the gate lives in
   * src/db/tasks.updateTaskStatus so every write path (AI tool,
   * direct command, button flow) inherits it from the same place.
   */
  parent_task_id: number | null;
  created_at: string;
  updated_at: string;
}

// Re-exported for callers that used to import RecurrenceRule from
// this module. New code should prefer importing from '../types/shared'.
export type { RecurrenceRule };
