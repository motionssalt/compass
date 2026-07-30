// Gemini function-calling tool declarations. Types here mirror
// Gemini's "functionDeclarations" spec exactly.

export const TOOL_DECLARATIONS = [
  {
    name: 'create_task',
    description:
      'Create a new task for the user. Use this whenever the user mentions something they need to do, whether one-off or recurring.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: {
          type: 'STRING',
          description: 'Short human-readable name of the task.',
        },
        priority: {
          type: 'INTEGER',
          description: '1 highest, 3 normal, 5 lowest. Default 3.',
        },
        context_note: {
          type: 'STRING',
          description:
            'Optional free-text: why this matters, when it is relevant, any extra detail the user gave.',
        },
        scheduled_for: {
          type: 'STRING',
          description:
            'Optional. ISO datetime OR loose text like "morning", "this week", "tonight". Leave empty if the user did not specify a time.',
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
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task_status',
    description:
      'Change a task\'s status. Use "done" when the user finished it, "in_progress" when they say they are working on it, "pending" to reopen.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID of the task from the open-task list.' },
        status: {
          type: 'STRING',
          description: 'One of: pending, in_progress, done, cancelled.',
        },
      },
      required: ['task_id', 'status'],
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
            'One of: pending, in_progress, done, cancelled, today, recurring.',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'edit_task',
    description: 'Edit fields on an existing task (title, priority, context, scheduling, recurrence).',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER' },
        fields: {
          type: 'OBJECT',
          description: 'Any subset of: title, priority, context_note, scheduled_for, is_recurring, recurrence_rule, status.',
          properties: {
            title: { type: 'STRING' },
            priority: { type: 'INTEGER' },
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
      'The user reports money arriving (paid, transfer received, cash in hand). Adds the amount to their running balance. Non-destructive — no confirmation needed. After calling this, look at open debts (especially the user\'s own, urgent ones) and give ONE specific, low-effort recommendation for what to do with the new money.',
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
    name: 'create_debt',
    description:
      'Record a new debt / obligation. IMPORTANT: responsible_party distinguishes debts the user owes themselves ("user") from money the user is holding for someone else to pay ("other"). Ask ONE short clarifying question if it is genuinely unclear — never assume "user" when the user hinted otherwise (e.g. "I owe my landlord but it\'s actually for mom"). Non-destructive.',
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
        urgency: { type: 'INTEGER', description: '1 highest, 3 normal, 5 lowest. Default 3.' },
        note: { type: 'STRING', description: 'Optional free-text context.' },
      },
      required: ['creditor', 'amount'],
    },
  },
  {
    name: 'edit_debt',
    description: 'Edit fields on an existing debt (creditor, amount, responsible_party, on_behalf_of, due, urgency, note, status, currency). Non-destructive.',
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
            urgency: { type: 'INTEGER' },
            note: { type: 'STRING' },
            status: { type: 'STRING', description: 'One of: open, paid, cancelled.' },
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
      'Fetch debts from the DB. The system prompt already carries all open debts, so only call this for filters not covered there (paid history, cancelled, everything).',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          description: 'One of: open, paid, cancelled, user, other, all.',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_balance',
    description:
      'Fetch the current running balance. The system prompt already contains it, so usually you do NOT need to call this — only if you suspect the snapshot is stale (e.g. after a chain of tool calls in the same turn).',
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
