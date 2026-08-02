// Gemini function-calling tool declarations. Types here mirror
// Gemini's "functionDeclarations" spec exactly.
//
// Priority / urgency use a LETTER-GRADE scale (A+, A, A-, B+, B, B-,
// C+, C, C-, D+, D, D-, E+, E, E-). See src/utils/priority.ts for
// the canonical helper — the AI never sees the underlying integer.

// ---------------------------------------------------------------
// Shared: schedule_constraint schema.
//
// The stored shape lives in src/types/shared.ts (SchedulingConstraint)
// and is parsed/validated by src/utils/scheduleConstraint.ts — this
// declaration mirrors that shape 1:1 so the AI writes the same JSON
// the direct-command parser writes. Kept as a const so create_task
// and edit_task stay identical (and stay in sync automatically).
//
// Independent from `scheduled_for` and `recurrence_rule`: a
// constraint can layer on top of either, or stand alone. Every
// sub-field is optional; passing an empty / all-null constraint is
// equivalent to no constraint at all.
const SCHEDULE_CONSTRAINT_SCHEMA = {
  type: 'OBJECT',
  description:
    'Optional structured scheduling constraint. Any combination of the three sub-fields is legal; all three are independent of each other AND of scheduled_for / recurrence_rule. Applies to one-off and recurring tasks alike. Set this when the user narrows WHEN a task may happen without pinning a single moment — e.g. "any weekday morning before Aug 15", "Mon/Wed/Fri between 07:00 and 08:00", "some time before Friday". Prefer scheduled_for for a single concrete moment; prefer recurrence_rule for the cadence of a repeating habit; use this for windows on top. Omit the field entirely (or pass null) when the user did not narrow anything. Times and dates are in the user\'s timezone.',
  properties: {
    date_range: {
      type: 'OBJECT',
      description:
        'Inclusive wall-clock date range. Either side may be omitted (open-ended windows are legal). Dates are "YYYY-MM-DD".',
      properties: {
        start: { type: 'STRING', description: 'YYYY-MM-DD, inclusive. Omit for "no lower bound".' },
        end: { type: 'STRING', description: 'YYYY-MM-DD, inclusive. Omit for "no upper bound".' },
      },
    },
    time_of_day: {
      type: 'OBJECT',
      description:
        'Daily HH:MM..HH:MM window (24-hour). Both ends required when time_of_day is present. Wraparound windows (start > end, e.g. 22:00..02:00) are supported and mean "from start today through end tomorrow". Inclusive at start, exclusive at end.',
      properties: {
        start: { type: 'STRING', description: 'HH:MM 24-hour.' },
        end: { type: 'STRING', description: 'HH:MM 24-hour.' },
      },
    },
    days_of_week: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Applicable weekdays as lowercase 3-letter codes: mon, tue, wed, thu, fri, sat, sun. Omit or pass all seven for "any day".',
    },
  },
} as const;

export const TOOL_DECLARATIONS = [
  {
    name: 'create_task',
    description:
      'Create a new task for the user. Use this whenever the user mentions something they need to do, whether one-off or recurring. ALWAYS supply a `priority` letter grade yourself — pick your best-judgment grade (A+..E-) based on how important and time-sensitive the task appears from what the user said (their words, urgency cues, whether it blocks other things, whether it names a deadline). Do not omit priority to fall back to a default; the user is relying on your judgment to infer it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: {
          type: 'STRING',
          description: 'Short human-readable name of the task.',
        },
        priority: {
          type: 'STRING',
          description:
            'Letter grade priority. One of: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, E+, E, E-. A+ = must happen now / blocking. A = today, high importance. B = this week, important. C = normal (baseline for a task with no urgency cues). D = nice-to-have / low. E = someday / drop-if-needed; E- = practically shelved. ALWAYS supply your best-judgment grade based on the task\'s apparent importance — do not omit this field.',
        },
        context_note: {
          type: 'STRING',
          description:
            'Optional free-text: why this matters, when it is relevant, any extra detail the user gave.',
        },
        scheduled_for: {
          type: 'STRING',
          description:
            'Optional. ISO datetime OR loose text like "morning", "this week", "tonight". Leave empty if the user did not specify a time. If the user only narrowed a WINDOW (a date range, a time-of-day window, or specific weekdays), use schedule_constraint instead of stuffing that into this field.',
        },
        is_recurring: {
          type: 'BOOLEAN',
          description:
            'True for daily/weekly habits (Bible study, prayer, language practice, exercise, etc.).',
        },
        recurrence_rule: {
          type: 'OBJECT',
          description:
            'Only when is_recurring=true. { "freq": "daily" } or { "freq": "weekly", "days": ["mon","wed","fri"] }',
          properties: {
            freq: { type: 'STRING', description: '"daily" or "weekly"' },
            days: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description:
                'For weekly only: lowercase 3-letter day codes: mon,tue,wed,thu,fri,sat,sun',
            },
          },
        },
        time_estimate_minutes: {
          type: 'INTEGER',
          description:
            'Optional rough duration in minutes. Set it when the user hints at how long the task takes ("quick 5-min call", "spend an hour on X", "half-day thing"); otherwise leave empty. Whole minutes, positive.',
        },
        schedule_constraint: SCHEDULE_CONSTRAINT_SCHEMA,
        depends_on_task_id: {
          type: 'INTEGER',
          description:
            'Optional SOFT dependency — the id of another task this new task can\'t reasonably start until. Purely informational: no write blocks on it, but the nudger will skip suggesting a task whose dependency is still open, and listings show a ⛓ marker. Must reference a task on the same user\'s list. Omit for no dependency.',
        },
        parent_task_id: {
          type: 'INTEGER',
          description:
            'Optional parent pointer — set this to make the new task a SUBTASK of the given parent task. Task must belong to the same user. A parent task cannot be marked done while any subtask is still open (pending / in_progress / paused) — update_task_status and edit_task will refuse the status change and name the open subtasks. Omit for a top-level task.',
        },
      },
      required: ['title', 'priority'],
    },
  },
  {
    name: 'update_task_status',
    description:
      'Change a task\'s status. Use "done" when the user finished it, "in_progress" when they say they are working on it (or are about to start), "paused" when they are parking it for now (still on the list, but skipped by the free-time nudger and not counted as "active right now"), "pending" to reopen or unpause. Prefer the dedicated pause_task / resume_task tools when the intent is specifically to park / unpark — they read more clearly to future you.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID of the task from the open-task list.' },
        status: {
          type: 'STRING',
          description: 'One of: pending, in_progress, paused, done, cancelled.',
        },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'pause_task',
    description:
      'Park a task the user wants to hold off on for now without dropping it. Convenience wrapper around update_task_status with status="paused". A paused task stays visible in every listing, but is skipped by the free-time nudger and does NOT count as "active right now". Use this when the user says things like "pause X", "put X on hold", "hold off on X for now", "snooze X". If they instead want to drop the task entirely, use cancel_task; if they simply finished, use update_task_status with status="done".',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'resume_task',
    description:
      'Unpause a previously paused task — restores it to "pending" so it re-enters the free-time nudge pool. Convenience wrapper around update_task_status with status="pending". Use when the user says "unpause X", "resume X", "back on X", "pick X back up". If the task is already pending / in_progress, this is a no-op.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description:
      'Cancel a task the user no longer needs to do. Distinct from "done": cancelled tasks were dropped, not completed. After cancelling, suggest what to focus on next.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
        reason: {
          type: 'STRING',
          description: 'Optional short reason the user gave for dropping this task.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'Fetch tasks from the DB. The system prompt already contains the current open tasks, so only call this if you need something different (e.g. done history, cancelled, all recurring, today\'s scope).',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          description:
            'One of: pending, in_progress, paused, done, cancelled, today, recurring.',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'edit_task',
    description: 'Edit fields on an existing task (title, priority letter grade, context, scheduling, recurrence, time estimate, schedule_constraint, dependency pointer, parent pointer). Pass schedule_constraint=null / depends_on_task_id=null / parent_task_id=null to clear a previously-set value. NOTE: attempting to move a parent task to status="done" while any of its subtasks is still open (pending / in_progress / paused) will fail with a structured error naming the blocking subtask ids — finish or cancel those first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
        fields: {
          type: 'OBJECT',
          description: 'Any subset of: title, priority (letter grade A+..E-), context_note, scheduled_for, is_recurring, recurrence_rule, status, time_estimate_minutes, schedule_constraint, depends_on_task_id, parent_task_id.',
          properties: {
            title: { type: 'STRING' },
            priority: {
              type: 'STRING',
              description: 'Letter grade: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, E+, E, E-.',
            },
            context_note: { type: 'STRING' },
            scheduled_for: { type: 'STRING' },
            is_recurring: { type: 'BOOLEAN' },
            recurrence_rule: {
              type: 'OBJECT',
              properties: {
                freq: { type: 'STRING' },
                days: { type: 'ARRAY', items: { type: 'STRING' } },
              },
            },
            status: { type: 'STRING' },
            time_estimate_minutes: {
              type: 'INTEGER',
              description: 'Rough duration in minutes. Positive whole number; pass 0 or negative to clear it.',
            },
            schedule_constraint: SCHEDULE_CONSTRAINT_SCHEMA,
            depends_on_task_id: {
              type: 'INTEGER',
              description:
                'Set/replace the soft dependency pointer to this task id (must belong to the same user, must not be this task\'s own id). Pass 0 or a negative number to CLEAR the dependency. Leave the field absent to keep the existing value.',
            },
            parent_task_id: {
              type: 'INTEGER',
              description:
                'Set/replace the parent pointer — makes this task a subtask of the given id (must belong to the same user, must not be this task\'s own id). Pass 0 or a negative number to CLEAR the parent (detach from the current parent, becoming top-level again). Leave the field absent to keep the existing value.',
            },
          },
        },
      },
      required: ['task_id', 'fields'],
    },
  },
  {
    name: 'delete_task',
    description:
      'Hard-delete a task. Use only when the user explicitly asks to remove/forget/erase it (not just cancel).',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
      },
      required: ['task_id'],
    },
  },

  // ==============================================================
  // Finance tools — first-class peers of the task tools above.
  // The system prompt already carries the current balance and open
  // debts, so read-only fetches are usually unnecessary; the list_*
  // tools are here for edge cases (history, cancelled debts).
  // ==============================================================
  {
    name: 'record_income',
    description:
      'The user reports money arriving (paid, transfer received, cash in hand). Adds the amount to their running balance. Non-destructive — no confirmation needed. After calling this, look at open debts (especially the user\'s own, urgent ones) and give ONE specific, low-effort recommendation for what to do with the new money. If nothing obvious matches AND the user did not say what the money is for, ACT — call move_to_set_aside to park it in the set-aside bucket rather than leaving it loose in the main balance, then say plainly you parked it and will help decide later.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'STRING',
          description: 'The amount that arrived, as a plain decimal string (e.g. "500", "1234.50"). Do NOT include a currency symbol.',
        },
        note: {
          type: 'STRING',
          description: 'Optional free-text: where the money came from ("paycheck", "mom sent for rent").',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'record_spend',
    description:
      'The user reports money leaving their balance for something other than paying a tracked debt (a purchase, a transfer out, cash handed over). Subtracts the amount from the running balance. Non-destructive. If the user is applying money to a specific tracked debt, use apply_payment_to_debt instead so the debt itself decrements.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'STRING',
          description: 'The amount that left, as a plain positive decimal string.',
        },
        note: { type: 'STRING' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'adjust_balance',
    description:
      'Small correction to the running balance (rounding fix, forgotten +/-). Signed delta. Use this for corrections; use record_income / record_spend for actual money movement. Non-destructive for small deltas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        delta: {
          type: 'STRING',
          description: 'Signed decimal string, e.g. "+2.50" or "-10". Include the sign.',
        },
        note: { type: 'STRING' },
      },
      required: ['delta'],
    },
  },
  {
    name: 'move_to_set_aside',
    description:
      'Park money in the user\'s "set-aside / undecided" bucket — a separate per-user pool that lives alongside the main balance in the same currency. Use this ACTIVELY, not as a suggestion: when income arrives with no obvious use, when the user says "hold this for now" / "I don\'t know what this is for yet" / "save this bit", or when you\'d otherwise dump money into the main balance and hope the user remembers not to spend it. Non-destructive, no confirmation needed. Mirrors adjust_balance in style — just call it.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'STRING',
          description: 'The amount to move into the set-aside bucket, as a plain positive decimal string. Subtracted from the main balance and added to the bucket.',
        },
        note: {
          type: 'STRING',
          description: 'Optional short reason ("undecided", "holding for rent decision next week").',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'move_from_set_aside',
    description:
      'Move money out of the set-aside bucket back into the main balance, e.g. because the user has now decided what to do with it (about to spend it, apply to a debt, or just release it). Non-destructive, no confirmation needed. Mirrors move_to_set_aside in style.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'STRING',
          description: 'The amount to release from the bucket back to the main balance, as a plain positive decimal string.',
        },
        note: { type: 'STRING' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'set_balance',
    description:
      'Overwrite the running balance to an exact number. This REPLACES whatever is currently there — use it only when the user explicitly states their current total (e.g. "my balance is 4200 right now"). If the new value differs a lot from the current one (>50% change or >100 units in either direction), this action requires confirmation: call request_confirmation with action="overwrite_balance" first, then re-call set_balance in the next turn with the returned confirm_token.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: {
          type: 'STRING',
          description: 'The new balance, as a plain decimal string.',
        },
        currency: {
          type: 'STRING',
          description: 'Optional 3-letter code (USD, KES, EUR...). Leave empty to keep the existing currency.',
        },
        confirm_token: {
          type: 'STRING',
          description: 'Required only when confirmation was requested for a large overwrite. Pass the token returned by request_confirmation.',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'set_default_currency',
    description:
      'Set the user\'s default currency (3-letter code, e.g. USD, KES, EUR). This is the currency used when a new balance row is materialised for the user and when create_debt is called without an explicit currency. Independent of any single balance edit — does NOT change the existing balance row\'s currency. Non-destructive, no confirmation needed. Call this the first time the user names their currency, or when they say "switch me to X by default".',
    parameters: {
      type: 'OBJECT',
      properties: {
        currency: {
          type: 'STRING',
          description: '3-letter currency code, e.g. USD, KES, EUR, GBP.',
        },
      },
      required: ['currency'],
    },
  },
  {
    name: 'create_debt',
    description:
      'Record a new debt / obligation. IMPORTANT: responsible_party distinguishes debts the user owes themselves ("user") from money the user is holding for someone else to pay ("other"). Ask ONE short clarifying question if it is genuinely unclear — never assume "user" when the user hinted otherwise (e.g. "I owe my landlord but it\'s actually for mom"). Non-destructive. If the debt is a repeating obligation (monthly rent, weekly subscription, biweekly bill), set is_recurring=true and provide a recurrence_rule — same shape as tasks. Supply your best-judgment `urgency` letter grade based on how soon and how consequential the debt is.',
    parameters: {
      type: 'OBJECT',
      properties: {
        creditor: { type: 'STRING', description: 'Who the money is owed to.' },
        amount: { type: 'STRING', description: 'Outstanding amount as a plain decimal string.' },
        currency: { type: 'STRING', description: 'Optional 3-letter code. Defaults to the user\'s current balance currency.' },
        responsible_party: {
          type: 'STRING',
          description: '"user" (user\'s own debt) or "other" (someone else\'s debt the user is holding money for). Default "user".',
        },
        on_behalf_of: {
          type: 'STRING',
          description: 'Only when responsible_party="other": name of the person whose debt this really is (e.g. "mom", "roommate").',
        },
        due: {
          type: 'STRING',
          description: 'Optional. ISO datetime OR loose text like "end of month", "next Friday", same pattern as task scheduled_for.',
        },
        urgency: {
          type: 'STRING',
          description:
            'Letter grade: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, E+, E, E-. A+ = pay today / severe consequence, A = this week, C = normal, E = shelvable. Supply your best-judgment grade.',
        },
        note: { type: 'STRING', description: 'Optional free-text context.' },
        is_recurring: {
          type: 'BOOLEAN',
          description: 'True for repeating obligations (rent, subscriptions, monthly bills). Defaults to false.',
        },
        recurrence_rule: {
          type: 'OBJECT',
          description:
            'Only when is_recurring=true. Same shape as tasks: { "freq": "daily" } or { "freq": "weekly", "days": ["mon"] }.',
          properties: {
            freq: { type: 'STRING', description: '"daily" or "weekly"' },
            days: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'For weekly only: mon,tue,wed,thu,fri,sat,sun.',
            },
          },
        },
      },
      required: ['creditor', 'amount', 'urgency'],
    },
  },
  {
    name: 'edit_debt',
    description: 'Edit fields on an existing debt (creditor, amount, responsible_party, on_behalf_of, due, urgency letter grade, note, status, currency, is_recurring, recurrence_rule). Non-destructive.',
    parameters: {
      type: 'OBJECT',
      properties: {
        debt_id: { type: 'INTEGER' },
        fields: {
          type: 'OBJECT',
          properties: {
            creditor: { type: 'STRING' },
            amount: { type: 'STRING', description: 'New outstanding amount as a plain decimal string.' },
            currency: { type: 'STRING' },
            responsible_party: { type: 'STRING' },
            on_behalf_of: { type: 'STRING' },
            due: { type: 'STRING' },
            urgency: {
              type: 'STRING',
              description: 'Letter grade: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, E+, E, E-.',
            },
            note: { type: 'STRING' },
            status: { type: 'STRING', description: 'One of: open, paid, cancelled.' },
            is_recurring: { type: 'BOOLEAN' },
            recurrence_rule: {
              type: 'OBJECT',
              properties: {
                freq: { type: 'STRING' },
                days: { type: 'ARRAY', items: { type: 'STRING' } },
              },
            },
          },
        },
      },
      required: ['debt_id', 'fields'],
    },
  },
  {
    name: 'apply_payment_to_debt',
    description:
      'Apply a payment against a tracked debt. Decrements the debt\'s outstanding amount AND, when responsible_party="user" and from_balance=true, subtracts the same amount from the user\'s balance. NEVER pay a debt whose responsible_party="other" from the user\'s balance — for those, leave from_balance false (the user is only passing cash through). Non-destructive.',
    parameters: {
      type: 'OBJECT',
      properties: {
        debt_id: { type: 'INTEGER' },
        amount: { type: 'STRING', description: 'Amount paid, plain positive decimal string.' },
        from_balance: {
          type: 'BOOLEAN',
          description: 'True to also subtract from the running balance. Only true for the user\'s own debts.',
        },
        note: { type: 'STRING' },
      },
      required: ['debt_id', 'amount'],
    },
  },
  {
    name: 'mark_debt_paid',
    description: 'Mark a debt fully paid (outstanding -> 0, status -> paid). Does not touch the balance — use apply_payment_to_debt with from_balance=true if the user is paying it out of their balance right now. Non-destructive.',
    parameters: {
      type: 'OBJECT',
      properties: {
        debt_id: { type: 'INTEGER' },
      },
      required: ['debt_id'],
    },
  },
  {
    name: 'cancel_debt',
    description: 'Mark a debt as cancelled (no longer owed; e.g. forgiven, written off). Distinct from paid. Non-destructive — the row stays for history.',
    parameters: {
      type: 'OBJECT',
      properties: {
        debt_id: { type: 'INTEGER' },
        reason: { type: 'STRING' },
      },
      required: ['debt_id'],
    },
  },
  {
    name: 'delete_debt',
    description:
      'Hard-delete a debt row. Destructive — requires confirmation: FIRST call request_confirmation with action="delete_debt", tell the user "you\'re about to delete debt #X, confirm?", and only re-call delete_debt in the next turn with the returned confirm_token once the user affirms. Prefer cancel_debt for "no longer owed" cases — only truly delete when the user says "erase / forget / remove entirely".',
    parameters: {
      type: 'OBJECT',
      properties: {
        debt_id: { type: 'INTEGER' },
        confirm_token: {
          type: 'STRING',
          description: 'Required. Token returned by a prior request_confirmation call in the same short window.',
        },
      },
      required: ['debt_id', 'confirm_token'],
    },
  },
  {
    name: 'list_debts',
    description:
      'Fetch debts from the DB. The system prompt already carries all open debts, so only call this for filters not covered there (paid history, cancelled, everything, recurring set).',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          description: 'One of: open, paid, cancelled, user, other, all, recurring.',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_balance',
    description:
      'Fetch the current running balance (and the set-aside bucket). The system prompt already contains both, so usually you do NOT need to call this — only if you suspect the snapshot is stale (e.g. after a chain of tool calls in the same turn).',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'request_confirmation',
    description:
      'REQUIRED before any destructive financial action (delete_debt, or set_balance with a large overwrite). Records a short-lived confirmation token and returns it. After calling this, tell the user in plain language what you are about to do and wait for their next turn. If they confirm, call the destructive tool again with confirm_token=<the token you got here>. If they decline, do nothing and drop the plan.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          description: 'One of: delete_debt, overwrite_balance.',
        },
        payload: {
          type: 'OBJECT',
          description: 'The arguments the destructive tool will be called with (e.g. { "debt_id": 7 } or { "amount": "0", "currency": "USD" }). This is stored server-side and echoed back on consumption for audit.',
        },
        summary: {
          type: 'STRING',
          description: 'Short human-readable description of what will happen, used for logging and safety.',
        },
      },
      required: ['action', 'summary'],
    },
  },
] as const;
