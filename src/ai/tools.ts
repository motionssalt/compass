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
] as const;
