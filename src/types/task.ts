export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface Task {
  id: number;
  user_id: number;
  title: string;
  status: TaskStatus;
  priority: number;
  context_note: string | null;
  scheduled_for: string | null;
  is_recurring: number;         // 0 or 1
  recurrence_rule: string | null; // JSON string
  last_completed_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurrenceRule {
  freq: 'daily' | 'weekly';
  // For weekly: lowercase 3-letter day codes: mon, tue, wed, thu, fri, sat, sun
  days?: string[];
}
