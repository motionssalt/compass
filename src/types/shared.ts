// Shared domain types used by both the task and finance sides. Kept
// here (rather than re-exported from one feature module) so neither
// task.ts nor finance.ts has to import from the other.

/**
 * Recurrence rule for anything that repeats on a daily/weekly cadence
 * — used by both recurring tasks and recurring debts (e.g. monthly
 * rent modelled as a weekly rule on a fixed day, or a daily habit).
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly';
  // For weekly: lowercase 3-letter day codes: mon, tue, wed, thu, fri, sat, sun
  days?: string[];
}
