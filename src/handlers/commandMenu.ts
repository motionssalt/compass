// Single source of truth for the direct slash commands that
// handleSlashCommand (src/handlers/webhook.ts) currently supports.
//
// This list is consumed by services/telegram.ts#setMyCommands to
// populate Telegram's built-in command menu UI. If you add or remove
// a case in handleSlashCommand, update this list too.
//
// NOTE: /help's help-text string in webhook.ts is deliberately NOT
// wired to this list yet — that copy is human-tuned prose, not a
// menu. It will be reconciled with this list in the final rollout
// part alongside the README refresh. Until then, keep them in sync
// by hand.
//
// Telegram's setMyCommands has two hard rules for each entry:
//   - `command` must be 1-32 chars, lowercase, no leading slash,
//     [a-z0-9_] only.
//   - `description` must be 3-256 chars.
// Aliases (e.g. /add vs /addtask, /tz vs /timezone, /settings vs
// /menu) are omitted on purpose: Telegram's menu should show one
// canonical entry per action, not both. The aliases keep working —
// they're just not advertised in the menu.

export interface BotCommand {
  command: string;      // without leading slash
  description: string;  // 3-256 chars, shown in the Telegram menu
}

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start',      description: 'Introduce Compass and get going' },
  { command: 'help',       description: 'Show quick commands and examples' },
  { command: 'menu',       description: 'Open the button-driven menu (also /settings)' },
  { command: 'today',      description: "Show today's tasks" },
  { command: 'alltasks',   description: 'Show every open task, today + non-today (also /all)' },
  { command: 'balance',    description: 'Show your current balance' },
  { command: 'debts',      description: 'List your open debts' },
  { command: 'finance',    description: 'Balance and debts summary' },
  { command: 'addtask',    description: 'Add a single task (also /add)' },
  { command: 'addbatch',   description: 'Add several tasks at once (also /batch)' },
  { command: 'edittask',   description: 'Edit an existing task by id (also /edit)' },
  { command: 'deletetask', description: 'Delete a task by id, with confirm (also /del)' },
  { command: 'review',     description: 'Review flexible / unscheduled tasks (also /flex)' },
  { command: 'setbalance', description: 'Overwrite the balance directly' },
  { command: 'timezone',   description: 'Set your IANA timezone (also /tz)' },
  { command: 'reset',      description: 'Wipe all your data and start fresh (asks to confirm)' },
];
