import type { RecurrenceRule } from './shared';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

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
  created_at: string;
  updated_at: string;
}

// Re-exported for callers that used to import RecurrenceRule from
// this module. New code should prefer importing from '../types/shared'.
export type { RecurrenceRule };
