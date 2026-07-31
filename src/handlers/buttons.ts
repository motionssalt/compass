// Inline-keyboard callback_query dispatcher.
//
// Sits alongside processMessage (src/handlers/webhook.ts) as the
// non-AI counterpart: every user tap on an inline button lands here.
// We MUST answerCallbackQuery for every update — otherwise the tap
// shows a stuck loading spinner on the client — so the outer wrapper
// in webhook.ts always calls it, even on error.
//
// Every action in this file routes to the SAME src/db/*.ts helpers
// the typed slash commands and AI tools use — no forked logic,
// no duplicated queries. Confirmation-gated actions (delete_debt,
// large balance overwrites) go through the existing
// pending_confirmations flow untouched.
//
// This file NEVER calls runAgent / Gemini.

import type { Env } from '../types/env';
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  InlineKeyboardMarkup,
} from '../types/telegram';
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
} from '../services/telegram';
import {
  upsertUser, getUserTimezone, resolveUserTimezone, setUserTimezone,
  isValidIanaTimezone, setUserDefaultCurrency,
} from '../db/users';
import {
  listTasksByFilter, listOpenTasks, listAllOpenTasks,
  createTask, editTask, deleteTask, getTaskById, updateTaskStatus,
} from '../db/tasks';
import type { TaskStatus } from '../types/task';
import { resetUserData } from '../db/reset';
import {
  getBalance, setBalance, adjustBalance, moveToSetAside, moveFromSetAside,
} from '../db/balance';
import { listOpenDebts } from '../db/debts';
import { rememberChatId } from '../db/nudge';
import { createConfirmation, consumeConfirmation } from '../db/confirmations';
import {
  getFlow, startFlow, advanceFlow, clearFlow, type FlowState,
} from '../db/flows';
import { parseAmountToCents, formatMoney, formatCents } from '../utils/money';
import { priorityIntToLetter, DEFAULT_PRIORITY_INT, isValidPriorityLetter } from '../utils/priority';
import { isFlexibleTask } from '../utils/nudgeScoring';
import { localNow } from '../utils/time';
import { comparePriorityInt } from '../utils/priority';
import {
  decodeCb,
  rootMenuKeyboard, ROOT_MENU_TEXT,
  tasksMenuKeyboard, TASKS_MENU_TEXT,
  financeMenuKeyboard, FINANCE_MENU_TEXT,
  settingsMenuKeyboard, SETTINGS_MENU_TEXT,
  priorityBandKeyboard, priorityFineKeyboard,
  durationKeyboard, confirmCreateKeyboard,
  taskPickerKeyboard, editFieldKeyboard, statusPickerKeyboard,
  timezoneKeyboard, TZ_SLOTS,
  currencyKeyboard, CURRENCY_SLOTS,
  overwriteConfirmKeyboard, deleteTaskConfirmKeyboard, resetConfirmKeyboard,
  constraintPartsKeyboard, constraintDaysKeyboard,
  constraintTextPromptKeyboard, describeConstraintForMenu,
  WEEKDAY_CODES, type WeekdayCode,
} from './menuUi';
import { parseConstraintExpression } from './directTasks';
import { safeParseStoredConstraint } from '../utils/scheduleConstraint';
import type { SchedulingConstraint } from '../types/shared';
import { log } from '../utils/logger';

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------

export async function processCallbackQuery(
  env: Env, cq: TelegramCallbackQuery,
): Promise<void> {
  const from = cq.from;
  const userId = from.id;
  await upsertUser(env.DB, userId, from.first_name ?? null, from.username ?? null);
  const chatId = cq.message?.chat.id;
  if (chatId !== undefined) {
    await rememberChatId(env.DB, userId, chatId);
  }

  const decoded = cq.data ? decodeCb(cq.data) : null;
  if (!decoded) {
    await answerCallbackQuery(env, cq.id, 'This button is out of date.');
    return;
  }

  // Dispatch by domain. Any handler that fully replies (edit-in-place
  // or new message) is responsible for calling answerCallbackQuery
  // itself so it can pass its own toast text; the fallback below
  // handles cases where the branch returned without one.
  let ackText: string | undefined;
  try {
    if (decoded.domain === 'root') {
      ackText = await handleRoot(env, cq, decoded.action);
    } else if (decoded.domain === 'nav') {
      ackText = await handleNav(env, cq, decoded.action);
    } else if (decoded.domain === 'tasks') {
      ackText = await handleTasks(env, cq, decoded.action, decoded.args);
    } else if (decoded.domain === 'fin') {
      ackText = await handleFinance(env, cq, decoded.action, decoded.args);
    } else if (decoded.domain === 'set') {
      ackText = await handleSettings(env, cq, decoded.action, decoded.args);
    } else if (decoded.domain === 'flow') {
      ackText = await handleFlow(env, cq, decoded.action, decoded.args);
    } else {
      ackText = 'Unknown button.';
    }
  } catch (err) {
    log.error('callback_dispatch_failed', {
      data: cq.data,
      err: err instanceof Error ? err.message : String(err),
    });
    ackText = 'Something jammed. Try /menu again.';
    if (chatId !== undefined) {
      await sendMessage(env, chatId,
        "Something jammed on my end. Give me a moment and try again.",
      ).catch(() => {});
    }
  }

  await answerCallbackQuery(env, cq.id, ackText);
}

// ---------------------------------------------------------------
// Root menu ("/menu") — also called by the /menu slash command
// ---------------------------------------------------------------

export async function openMenu(env: Env, chatId: number): Promise<void> {
  await sendMessage(env, chatId, ROOT_MENU_TEXT, {
    replyMarkup: rootMenuKeyboard(),
  });
}

async function handleRoot(
  env: Env, cq: TelegramCallbackQuery, action: string,
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  if (action === 'tasks') {
    await editOrSend(env, msg, TASKS_MENU_TEXT, tasksMenuKeyboard());
    return;
  }
  if (action === 'fin') {
    await editOrSend(env, msg, FINANCE_MENU_TEXT, financeMenuKeyboard());
    return;
  }
  if (action === 'set') {
    await editOrSend(env, msg, SETTINGS_MENU_TEXT, settingsMenuKeyboard());
    return;
  }
  return 'unknown';
}

async function handleNav(
  env: Env, cq: TelegramCallbackQuery, action: string,
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  if (action === 'root') {
    await editOrSend(env, msg, ROOT_MENU_TEXT, rootMenuKeyboard());
    return;
  }
  if (action === 'set') {
    await editOrSend(env, msg, SETTINGS_MENU_TEXT, settingsMenuKeyboard());
    return;
  }
  if (action === 'fin') {
    await editOrSend(env, msg, FINANCE_MENU_TEXT, financeMenuKeyboard());
    return;
  }
  if (action === 'close') {
    // Just strip the keyboard — leave the surrounding text alone
    // so the transcript still reads coherently.
    await editOrSend(env, msg, 'Menu closed. Send /menu to reopen.', { inline_keyboard: [] });
    await clearFlow(env.DB, cq.from.id);
    return 'closed';
  }
  return 'unknown';
}

// ---------------------------------------------------------------
// Tasks submenu
// ---------------------------------------------------------------

async function handleTasks(
  env: Env, cq: TelegramCallbackQuery, action: string, args: string[],
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  const userId = cq.from.id;

  if (action === 'today') {
    const tz = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
    const tasks = await listTasksByFilter(env.DB, userId, 'today', tz);
    const body = tasks.length === 0
      ? `Nothing on today's list. If something comes up, just tell me.`
      : `Today:\n${tasks.map(formatTaskLine).join('\n')}`;
    await editOrSend(env, msg, body, tasksMenuKeyboard());
    return;
  }

  if (action === 'flex') {
    const open = await listOpenTasks(env.DB, userId);
    const flexible = open
      .filter(isFlexibleTask)
      .sort((a, b) => {
        const p = comparePriorityInt(a.priority, b.priority);
        if (p !== 0) return p;
        return a.created_at.localeCompare(b.created_at);
      });
    const body = flexible.length === 0
      ? `No open flexible tasks. Everything on the list either has a hard time or is already in progress.`
      : `Flexible tasks (highest priority first):\n${flexible.map(formatTaskLine).join('\n')}`;
    await editOrSend(env, msg, body, tasksMenuKeyboard());
    return;
  }

  if (action === 'add') {
    // Multi-step: title (free text) → band → fine → duration → confirm.
    await startFlow(env.DB, userId, 'add_task', 'await_title', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Add a task — send me the title as your next message.\n\n(A short line, e.g. "Draft the report".)`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'editpick') {
    const open = await listOpenTasks(env.DB, userId);
    if (open.length === 0) {
      await editOrSend(env, msg, `No open tasks to edit.`, tasksMenuKeyboard());
      return;
    }
    await editOrSend(env, msg,
      `Pick a task to edit:`,
      taskPickerKeyboard(open, 'edit'),
    );
    return;
  }

  if (action === 'all') {
    // Every open task regardless of scheduled date — today +
    // non-today combined. Recurring tasks appear ONCE here.
    const tasks = await listAllOpenTasks(env.DB, userId);
    const body = tasks.length === 0
      ? `No open tasks. Everything is either done or you haven't added anything yet.`
      : `All open tasks (${tasks.length}):\n${tasks.map(formatTaskLine).join('\n')}`;
    await editOrSend(env, msg, body, tasksMenuKeyboard());
    return;
  }

  // Direct status-change pickers (Start / Finish / Pause / Resume).
  // Each shows the SAME open-task picker Edit Task and Delete Task
  // already use; the purpose token carries the eventual status
  // change through to the shared 'tpick' handler below so all task-
  // picker traffic flows through one codepath.
  //
  // For Pause we only offer tasks that are actually pausable
  // (pending or in_progress); for Resume we only offer paused tasks.
  // Otherwise the picker would be full of nonsensical targets. Start
  // and Finish stay broad — the shared 'tpick' handler no-ops if
  // the task is already in the target status.
  if (action === 'startpick' || action === 'finishpick'
      || action === 'pausepick' || action === 'resumepick') {
    const open = await listOpenTasks(env.DB, userId);
    const purpose =
      action === 'startpick'  ? 'start' :
      action === 'finishpick' ? 'finish' :
      action === 'pausepick'  ? 'pause' :
      /* resumepick */          'resume';
    const filtered =
      purpose === 'pause'  ? open.filter((t) => t.status === 'pending' || t.status === 'in_progress') :
      purpose === 'resume' ? open.filter((t) => t.status === 'paused') :
      open;
    if (filtered.length === 0) {
      const label =
        purpose === 'pause'  ? `No pausable tasks — nothing pending or in progress.` :
        purpose === 'resume' ? `No paused tasks to resume.` :
        `No open tasks.`;
      await editOrSend(env, msg, label, tasksMenuKeyboard());
      return;
    }
    const prompt =
      purpose === 'start'  ? `Pick a task to start:` :
      purpose === 'finish' ? `Pick a task to finish:` :
      purpose === 'pause'  ? `Pick a task to pause:` :
      /* resume */          `Pick a task to resume:`;
    await editOrSend(env, msg, prompt,
      taskPickerKeyboard(filtered, purpose),
    );
    return;
  }

  if (action === 'delpick') {
    // Show the same task list the edit-picker uses — same underlying
    // listOpenTasks query, no forked ordering. Tapping a row will
    // fire a `flow:tpick:delete:<id>` callback that lands on the
    // confirm gate below.
    const open = await listOpenTasks(env.DB, userId);
    if (open.length === 0) {
      await editOrSend(env, msg, `No open tasks to delete.`, tasksMenuKeyboard());
      return;
    }
    await editOrSend(env, msg,
      `Pick a task to delete:`,
      taskPickerKeyboard(open, 'delete'),
    );
    return;
  }

  if (action === 'delok') {
    // Delete-task confirmation button: reuse the same
    // pending_confirmations token the AI-side delete_debt flow uses.
    const token = args[0];
    if (!token) return 'no token';
    const row = await consumeConfirmation(env.DB, userId, token);
    if (!row || row.action !== 'delete_task') {
      await editOrSend(env, msg,
        `That confirmation link is stale — try Delete task again.`,
        tasksMenuKeyboard(),
      );
      return 'expired';
    }
    const payload = safeParse<{ task_id: number }>(row.payload);
    const id = payload?.task_id;
    if (!id) {
      await editOrSend(env, msg, `Bad confirmation payload.`, tasksMenuKeyboard());
      return;
    }
    // Route through the SAME deleteTask helper /delete_task (AI) uses.
    const ok = await deleteTask(env.DB, userId, id);
    await editOrSend(env, msg,
      ok ? `Deleted task #${id}.` : `No task #${id} — nothing to delete.`,
      tasksMenuKeyboard(),
    );
    await clearFlow(env.DB, userId);
    return ok ? 'deleted' : 'not found';
  }

  return 'unknown';
}

// ---------------------------------------------------------------
// Finance submenu
// ---------------------------------------------------------------

async function handleFinance(
  env: Env, cq: TelegramCallbackQuery, action: string, args: string[],
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  const userId = cq.from.id;

  if (action === 'bal') {
    const bal = await getBalance(env.DB, userId);
    const parts = [`Balance: ${formatMoney(bal.amount_cents, bal.currency)}`];
    if (bal.set_aside_cents) {
      parts.push(`Set aside: ${formatMoney(bal.set_aside_cents, bal.currency)}`);
    }
    await editOrSend(env, msg, parts.join('\n'), financeMenuKeyboard());
    return;
  }

  if (action === 'debts') {
    const debts = await listOpenDebts(env.DB, userId);
    if (debts.length === 0) {
      await editOrSend(env, msg, `No open debts.`, financeMenuKeyboard());
      return;
    }
    const lines = debts.map((d) => {
      const who = d.responsible_party === 'other'
        ? ` [for ${d.on_behalf_of ?? 'someone else'}]` : '';
      const due = d.due ? ` — due ${d.due}` : '';
      const urg = d.urgency && d.urgency !== DEFAULT_PRIORITY_INT
        ? ` (${priorityIntToLetter(d.urgency)})` : '';
      return `• #${d.id} ${d.creditor}: ${formatMoney(d.amount_cents, d.currency)}${who}${due}${urg}`;
    });
    await editOrSend(env, msg, `Open debts:\n${lines.join('\n')}`, financeMenuKeyboard());
    return;
  }

  if (action === 'add') {
    await startFlow(env.DB, userId, 'balance_add', 'await_amount', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Add to balance — send me the amount (e.g. "500" or "500 KES").`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'set') {
    await startFlow(env.DB, userId, 'balance_set', 'await_amount', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Set balance — send me the new total (e.g. "1234.50" or "1234.50 KES").\n\n(Large changes will ask you to confirm.)`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'aside_to') {
    await startFlow(env.DB, userId, 'setaside_to', 'await_amount', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Move to set-aside — send me the amount to move OUT of your main balance into the set-aside bucket.`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'aside_from') {
    await startFlow(env.DB, userId, 'setaside_from', 'await_amount', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Take from set-aside — send me the amount to move BACK from set-aside into your main balance.`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'curr') {
    await editOrSend(env, msg, `Pick your default currency:`, currencyKeyboard());
    return;
  }

  if (action === 'currpick') {
    const code = args[0];
    if (!code || !CURRENCY_SLOTS.includes(code)) return 'unknown currency';
    try {
      const applied = await setUserDefaultCurrency(env.DB, userId, code);
      await editOrSend(env, msg,
        `Default currency set to ${applied}.\n\nApplies to new debts without an explicit currency and to a first-time balance row.`,
        financeMenuKeyboard(),
      );
    } catch (err) {
      const em = err instanceof Error ? err.message : String(err);
      await editOrSend(env, msg, `Couldn't set currency: ${em}`, financeMenuKeyboard());
    }
    return;
  }

  if (action === 'currother') {
    await startFlow(env.DB, userId, 'currency_other', 'await_code', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Send me a 3-letter currency code (e.g. SEK, PLN, IDR).`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'setok') {
    // Large-balance-overwrite confirmation button: reuse the same
    // pending_confirmations token the AI-side flow uses.
    const token = args[0];
    if (!token) return 'no token';
    const row = await consumeConfirmation(env.DB, userId, token);
    if (!row || row.action !== 'overwrite_balance') {
      await editOrSend(env, msg,
        `That confirmation link is stale — try Set balance again.`,
        financeMenuKeyboard(),
      );
      return 'expired';
    }
    const payload = safeParse<{ amount_cents: number; currency?: string }>(row.payload);
    if (!payload || typeof payload.amount_cents !== 'number') {
      await editOrSend(env, msg, `Bad confirmation payload.`, financeMenuKeyboard());
      return;
    }
    const before = await getBalance(env.DB, userId);
    const after = await setBalance(env.DB, userId, payload.amount_cents, payload.currency);
    await editOrSend(env, msg,
      `Balance set: ${formatMoney(before.amount_cents, before.currency)} → ${formatMoney(after.amount_cents, after.currency)}`,
      financeMenuKeyboard(),
    );
    await clearFlow(env.DB, userId);
    return 'done';
  }

  return 'unknown';
}

// ---------------------------------------------------------------
// Settings submenu (timezone)
// ---------------------------------------------------------------

async function handleSettings(
  env: Env, cq: TelegramCallbackQuery, action: string, args: string[],
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  const userId = cq.from.id;

  if (action === 'tz') {
    // Show the resulting wall clock next to the identifier: the zone
    // name alone doesn't tell the user whether it's the right one, a
    // wrong time does. Same reasoning as the /timezone command.
    const { timezone: current, isExplicit } =
      await resolveUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
    const clock = localNow(new Date(), current);
    await editOrSend(env, msg,
      `Timezone — pick one.\n\n`
      + `Current: ${current}${isExplicit ? '' : ' (server default — not set by you)'}\n`
      + `That makes it ${clock.clock} on ${clock.weekdayLong} for you right now.`,
      timezoneKeyboard(),
    );
    return;
  }

  if (action === 'tzpick') {
    const idx = parseInt(args[0] ?? '', 10);
    const slot = Number.isFinite(idx) ? TZ_SLOTS[idx] : undefined;
    if (!slot) return 'unknown timezone';
    // Route through the SAME db helper the /timezone command uses.
    try {
      const before = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
      const after = await setUserTimezone(env.DB, userId, slot.iana);
      await editOrSend(env, msg,
        before === after
          ? `Timezone stays ${after}.`
          : `Timezone set: ${before} → ${after}`,
        settingsMenuKeyboard(),
      );
    } catch (err) {
      const em = err instanceof Error ? err.message : String(err);
      await editOrSend(env, msg, `Couldn't set timezone: ${em}`, settingsMenuKeyboard());
    }
    return;
  }

  if (action === 'tzother') {
    await startFlow(env.DB, userId, 'tz_other', 'await_iana', {}, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Send me an IANA timezone identifier (e.g. Africa/Lagos, America/Denver, Pacific/Auckland).`,
      cancelOnlyKeyboard(),
    );
    return;
  }

  if (action === 'reset') {
    // Ask for confirmation via the SAME pending_confirmations flow
    // used for delete_debt and overwrite_balance. No wipe happens
    // here — that's on the `resetok` branch below.
    const summary = `Wipe ALL your data: tasks, debts, balance & set-aside, timezone, default currency. Your saved Gemini API key is kept.`;
    const conf = await createConfirmation(env.DB, userId, 'reset_user_data', {}, summary);
    await editOrSend(env, msg,
      `${summary}\n\nThis can't be undone. Confirm?`,
      resetConfirmKeyboard(conf.token),
    );
    return;
  }

  if (action === 'resetok') {
    const token = args[0];
    if (!token) return 'no token';
    const row = await consumeConfirmation(env.DB, userId, token);
    if (!row || row.action !== 'reset_user_data') {
      await editOrSend(env, msg,
        `That confirmation link is stale — try Reset all data again.`,
        settingsMenuKeyboard(),
      );
      return 'expired';
    }
    const counts = await resetUserData(env.DB, userId);
    const lines = [
      `Done. Wiped:`,
      `• ${counts.tasks} task${counts.tasks === 1 ? '' : 's'}`,
      `• ${counts.debts} debt${counts.debts === 1 ? '' : 's'}`,
      `• balance & set-aside`,
      `• timezone & default currency`,
      `• chat history and pending state`,
      ``,
      `Your saved Gemini API key was kept. Send me anything to start fresh.`,
    ];
    await editOrSend(env, msg, lines.join('\n'), rootMenuKeyboard());
    await clearFlow(env.DB, userId);
    return 'reset';
  }

  return 'unknown';
}

// ---------------------------------------------------------------
// Flow actions (multi-step callbacks)
// ---------------------------------------------------------------

async function handleFlow(
  env: Env, cq: TelegramCallbackQuery, action: string, args: string[],
): Promise<string | undefined> {
  const msg = cq.message;
  if (!msg) return 'no message context';
  const userId = cq.from.id;

  if (action === 'cancel') {
    await clearFlow(env.DB, userId);
    await editOrSend(env, msg, `Cancelled.`, rootMenuKeyboard());
    return 'cancelled';
  }

  // Priority band-pick from add/edit flow.
  if (action === 'prio') {
    const purpose = args[0]; // 'add' | 'edit'
    const band = args[1];    // 'A'..'E' or 'skip'
    if (purpose === 'add') return await addFlowPriorityBand(env, cq, band);
    if (purpose === 'edit') return await editFlowPriorityBand(env, cq, band);
    return 'unknown purpose';
  }

  // Back button on the fine-tune step of the priority picker.
  if (action === 'priob') {
    const purpose = args[0];
    if (purpose === 'add') {
      await editOrSend(env, msg, `Priority (A highest, E lowest)?`, priorityBandKeyboard('add'));
      return;
    }
    if (purpose === 'edit') {
      await editOrSend(env, msg, `New priority (A highest, E lowest)?`, priorityBandKeyboard('edit'));
      return;
    }
    return 'unknown purpose';
  }

  // Priority fine-tune step.
  if (action === 'priof') {
    const purpose = args[0];
    const letter  = args[1];
    if (!isValidPriorityLetter(letter)) return 'bad priority';
    if (purpose === 'add') return await addFlowPriorityLetter(env, cq, letter);
    if (purpose === 'edit') return await editFlowPriorityLetter(env, cq, letter);
    return 'unknown purpose';
  }

  // Duration pick.
  if (action === 'dur') {
    const purpose = args[0];
    const value   = args[1]; // "5".."240" or "skip"
    if (purpose === 'add') return await addFlowDuration(env, cq, value);
    if (purpose === 'edit') return await editFlowDuration(env, cq, value);
    return 'unknown purpose';
  }

  // Final confirm on add-task.
  if (action === 'confirm') {
    if (args[0] === 'add') return await addFlowConfirm(env, cq);
    return 'unknown purpose';
  }

  // Task-picker for edit-task, delete-task, or the new direct
  // status-change pickers (start / finish / pause / resume).
  if (action === 'tpick') {
    const purpose = args[0];
    if (purpose !== 'edit' && purpose !== 'delete'
        && purpose !== 'start' && purpose !== 'finish'
        && purpose !== 'pause' && purpose !== 'resume') return 'unknown purpose';
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id) || id <= 0) return 'bad id';
    const existing = await getTaskById(env.DB, userId, id);
    if (!existing) {
      await editOrSend(env, msg, `That task is gone. Try again.`, tasksMenuKeyboard());
      await clearFlow(env.DB, userId);
      return;
    }
    // Route through the SAME updateTaskStatus helper the AI's
    // update_task_status / pause_task / resume_task tools and
    // /starttask, /finishtask, /pause, /resume slash-commands call —
    // no forked logic.
    if (purpose === 'start' || purpose === 'finish'
        || purpose === 'pause' || purpose === 'resume') {
      const targetStatus: TaskStatus =
        purpose === 'start'  ? 'in_progress' :
        purpose === 'finish' ? 'done' :
        purpose === 'pause'  ? 'paused' :
        /* resume */          'pending';
      if (existing.status === targetStatus) {
        await editOrSend(env, msg,
          `Task #${id} is already ${targetStatus}.`,
          tasksMenuKeyboard(),
        );
        await clearFlow(env.DB, userId);
        return purpose;
      }
      const updated = await updateTaskStatus(env.DB, userId, id, targetStatus);
      const verb =
        purpose === 'start'  ? 'Started' :
        purpose === 'finish' ? 'Finished' :
        purpose === 'pause'  ? 'Paused' :
        /* resume */          'Resumed';
      await editOrSend(env, msg,
        updated ? `${verb}: ${formatTaskLine(updated)}` : `No task #${id}.`,
        tasksMenuKeyboard(),
      );
      await clearFlow(env.DB, userId);
      return purpose;
    }
    if (purpose === 'delete') {
      // Second-stage gate — same pending_confirmations mechanism the
      // AI-side delete_debt flow and overwrite_balance flow use.
      const summary = `Delete task #${id} "${existing.title}"`;
      const conf = await createConfirmation(env.DB, userId, 'delete_task',
        { task_id: id }, summary);
      await editOrSend(env, msg,
        `${summary}\n\nThis removes the task permanently (not just cancel). Confirm?`,
        deleteTaskConfirmKeyboard(conf.token),
      );
      return;
    }
    await startFlow(env.DB, userId, 'edit_task', 'await_field',
      { task_id: id }, msg.chat.id, msg.message_id);
    await editOrSend(env, msg,
      `Editing #${id} ${existing.title}\n\nWhich field?`,
      editFieldKeyboard(id),
    );
    return;
  }

  // Edit-field router.
  if (action === 'efield') {
    const id = parseInt(args[0] ?? '', 10);
    const field = args[1];
    if (!Number.isFinite(id) || !field) return 'bad args';
    const existing = await getTaskById(env.DB, userId, id);
    if (!existing) {
      await editOrSend(env, msg, `That task is gone.`, tasksMenuKeyboard());
      await clearFlow(env.DB, userId);
      return;
    }
    if (field === 'title') {
      await startFlow(env.DB, userId, 'edit_task', 'await_title',
        { task_id: id }, msg.chat.id, msg.message_id);
      await editOrSend(env, msg,
        `New title for #${id}? Send it as your next message.`,
        cancelOnlyKeyboard());
      return;
    }
    if (field === 'prio') {
      await startFlow(env.DB, userId, 'edit_task', 'await_priority',
        { task_id: id }, msg.chat.id, msg.message_id);
      await editOrSend(env, msg,
        `New priority for #${id} (A highest, E lowest)?`,
        priorityBandKeyboard('edit'));
      return;
    }
    if (field === 'dur') {
      await startFlow(env.DB, userId, 'edit_task', 'await_duration',
        { task_id: id }, msg.chat.id, msg.message_id);
      await editOrSend(env, msg,
        `New duration for #${id}?`,
        durationKeyboard('edit'));
      return;
    }
    if (field === 'when') {
      await startFlow(env.DB, userId, 'edit_task', 'await_when',
        { task_id: id }, msg.chat.id, msg.message_id);
      await editOrSend(env, msg,
        `New "when" for #${id}? Send free text (e.g. "tonight", "friday morning") — or send "-" to clear it.`,
        cancelOnlyKeyboard());
      return;
    }
    if (field === 'status') {
      await startFlow(env.DB, userId, 'edit_task', 'await_status',
        { task_id: id }, msg.chat.id, msg.message_id);
      await editOrSend(env, msg,
        `New status for #${id}?`,
        statusPickerKeyboard(id));
      return;
    }
    if (field === 'constraint') {
      // Enter the constraint sub-menu. State-wise we sit on
      // `await_constraint_part` — the user's next tap picks which
      // sub-part they want (or clears / done). All follow-up steps
      // reuse this flow, so we stash the task id in state and stay
      // inside `edit_task`.
      await startFlow<EditTaskState>(env.DB, userId, 'edit_task', 'await_constraint_part',
        { task_id: id }, msg.chat.id, msg.message_id);
      const current = safeParseStoredConstraint(existing.schedule_constraint);
      await editOrSend(env, msg,
        `Constraint for #${id}: ${describeConstraintForMenu(current)}\n\n`
        + `Pick a part to change. Each part is independent — setting one leaves the others alone.`,
        constraintPartsKeyboard(id));
      return;
    }
    return 'unknown field';
  }

  // Constraint sub-menu — pick a part to edit.
  if (action === 'ecdates') {
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_dates',
      { task_id: id }, msg.message_id);
    await editOrSend(env, msg,
      `Date range for #${id}?\n\n`
      + `Send free text in the mini-syntax, e.g.\n`
      + `  2026-08-01..2026-08-15\n`
      + `  2026-08-01..     (from that date on)\n`
      + `  ..2026-08-15     (until that date)\n`
      + `  -                (clear the date range only)`,
      constraintTextPromptKeyboard(id));
    return;
  }

  if (action === 'ectime') {
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_time',
      { task_id: id }, msg.message_id);
    await editOrSend(env, msg,
      `Daily time window for #${id}?\n\n`
      + `Send free text, e.g.\n`
      + `  07:00-08:00\n`
      + `  22:00-02:00   (wraparound across midnight is OK)\n`
      + `  -             (clear the time window only)`,
      constraintTextPromptKeyboard(id));
    return;
  }

  if (action === 'ecdays') {
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    const existing = await getTaskById(env.DB, userId, id);
    if (!existing) {
      await editOrSend(env, msg, `That task is gone.`, tasksMenuKeyboard());
      await clearFlow(env.DB, userId);
      return;
    }
    const current = safeParseStoredConstraint(existing.schedule_constraint);
    // Seed the day-picker with whatever is already stored so users
    // start from the current selection, not an empty grid.
    const seed: WeekdayCode[] = (current?.days_of_week ?? []) as WeekdayCode[];
    await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_days',
      { task_id: id, days: seed }, msg.message_id);
    await editOrSend(env, msg,
      `Days of week for #${id}? Tap to toggle. Save when done — an empty selection clears the days-of-week part only.`,
      constraintDaysKeyboard(id, seed));
    return;
  }

  if (action === 'edow') {
    // Toggle a single day in the in-progress selection.
    const id = parseInt(args[0] ?? '', 10);
    const day = args[1];
    if (!Number.isFinite(id) || !day) return 'bad args';
    if (!(WEEKDAY_CODES as readonly string[]).includes(day)) return 'bad day';
    const flow = await getFlow<EditTaskState>(env.DB, userId);
    if (!flow || flow.flow !== 'edit_task' || flow.step !== 'await_constraint_days') {
      return 'no constraint flow';
    }
    const cur: WeekdayCode[] = (flow.state.days ?? []) as WeekdayCode[];
    const set = new Set<WeekdayCode>(cur);
    if (set.has(day as WeekdayCode)) set.delete(day as WeekdayCode);
    else set.add(day as WeekdayCode);
    // Store in canonical mon..sun order so the display stays stable.
    const next = WEEKDAY_CODES.filter((d) => set.has(d));
    await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_days',
      { days: next }, msg.message_id);
    await editOrSend(env, msg,
      `Days of week for #${id}? Tap to toggle. Save when done — an empty selection clears the days-of-week part only.`,
      constraintDaysKeyboard(id, next));
    return;
  }

  if (action === 'edowok') {
    // Commit the days-of-week selection. Merges into the existing
    // constraint via the SAME editTask helper every other edit uses.
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    const flow = await getFlow<EditTaskState>(env.DB, userId);
    if (!flow || flow.flow !== 'edit_task') return 'no edit-task flow';
    const days: WeekdayCode[] = (flow.state.days ?? []) as WeekdayCode[];
    return await commitConstraintPart(env, cq, id, (c) => {
      const next: SchedulingConstraint = { ...(c ?? {}) };
      if (days.length === 0) delete next.days_of_week;
      else next.days_of_week = [...days];
      return next;
    });
  }

  if (action === 'ecclr') {
    // Clear the whole constraint. Routes through editTask with
    // schedule_constraint=null, matching /schedule <id> clear.
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    const updated = await editTask(env.DB, userId, id, { schedule_constraint: null });
    if (!updated) {
      await editOrSend(env, msg, `No task #${id}.`, tasksMenuKeyboard());
    } else {
      await editOrSend(env, msg,
        `Constraint cleared: ${formatTaskLine(updated)}`,
        tasksMenuKeyboard());
    }
    await clearFlow(env.DB, userId);
    return 'cleared';
  }

  if (action === 'econback') {
    // Return to the parts sub-menu from a sub-picker.
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    const existing = await getTaskById(env.DB, userId, id);
    if (!existing) {
      await editOrSend(env, msg, `That task is gone.`, tasksMenuKeyboard());
      await clearFlow(env.DB, userId);
      return;
    }
    await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_part',
      { task_id: id }, msg.message_id);
    const current = safeParseStoredConstraint(existing.schedule_constraint);
    await editOrSend(env, msg,
      `Constraint for #${id}: ${describeConstraintForMenu(current)}\n\n`
      + `Pick a part to change.`,
      constraintPartsKeyboard(id));
    return;
  }

  if (action === 'econdone') {
    // Finish the constraint edit — no writes here, all sub-parts have
    // already committed themselves. Just close the flow and show the
    // final task state.
    const id = parseInt(args[0] ?? '', 10);
    if (!Number.isFinite(id)) return 'bad id';
    const existing = await getTaskById(env.DB, userId, id);
    if (existing) {
      await editOrSend(env, msg,
        `Done: ${formatTaskLine(existing)}`,
        tasksMenuKeyboard());
    } else {
      await editOrSend(env, msg, `Task gone.`, tasksMenuKeyboard());
    }
    await clearFlow(env.DB, userId);
    return 'done';
  }

  // Status pick for edit-task.
  if (action === 'estatus') {
    const id = parseInt(args[0] ?? '', 10);
    const status = args[1];
    if (!Number.isFinite(id) || !status) return 'bad args';
    if (!['pending', 'in_progress', 'paused', 'done', 'cancelled'].includes(status)) return 'bad status';
    const updated = await editTask(env.DB, userId, id, {
      status: status as TaskStatus,
    });
    if (!updated) {
      await editOrSend(env, msg, `No task #${id}.`, tasksMenuKeyboard());
    } else {
      await editOrSend(env, msg, `Updated: ${formatTaskLine(updated)}`, tasksMenuKeyboard());
    }
    await clearFlow(env.DB, userId);
    return 'done';
  }

  return 'unknown';
}

// ---------------------------------------------------------------
// Add-task flow — per-step handlers
// ---------------------------------------------------------------

interface AddTaskState extends Record<string, unknown> {
  title?: string;
  priority?: string;   // final letter, e.g. "A+"
  band?: string;       // interim band during pick, e.g. "A"
  duration?: number | null;
}

async function addFlowPriorityBand(
  env: Env, cq: TelegramCallbackQuery, band: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<AddTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'add_task') return 'no add-task flow';

  if (band === 'skip') {
    // Skip = keep default 'C'.
    await advanceFlow<AddTaskState>(env.DB, userId, 'await_duration',
      { priority: 'C', band: 'C' }, msg.message_id);
    await editOrSend(env, msg,
      `Priority: C (default)\n\nRough duration?`,
      durationKeyboard('add'),
    );
    return;
  }

  if (!/^[A-E]$/.test(band)) return 'bad band';
  await advanceFlow<AddTaskState>(env.DB, userId, 'await_priority_fine',
    { band }, msg.message_id);
  await editOrSend(env, msg,
    `Fine-tune ${band}? Pick +, plain, or -.`,
    priorityFineKeyboard('add', band),
  );
  return;
}

async function addFlowPriorityLetter(
  env: Env, cq: TelegramCallbackQuery, letter: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<AddTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'add_task') return 'no add-task flow';

  await advanceFlow<AddTaskState>(env.DB, userId, 'await_duration',
    { priority: letter }, msg.message_id);
  await editOrSend(env, msg,
    `Priority: ${letter}\n\nRough duration?`,
    durationKeyboard('add'),
  );
  return;
}

async function addFlowDuration(
  env: Env, cq: TelegramCallbackQuery, value: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<AddTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'add_task') return 'no add-task flow';

  let duration: number | null = null;
  if (value !== 'skip') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return 'bad duration';
    duration = n;
  }
  const updated = await advanceFlow<AddTaskState>(env.DB, userId, 'await_confirm',
    { duration }, msg.message_id);
  if (!updated) return 'flow expired';

  const s = updated.state;
  const summary = [
    `About to create:`,
    `• ${s.title}`,
    `  priority: ${s.priority ?? 'C'}${duration !== null ? `, ~${duration}min` : ''}`,
    ``,
    `Create it?`,
  ].join('\n');
  await editOrSend(env, msg, summary, confirmCreateKeyboard());
  return;
}

async function addFlowConfirm(
  env: Env, cq: TelegramCallbackQuery,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<AddTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'add_task') return 'no add-task flow';

  const s = flow.state;
  if (!s.title || !s.title.trim()) {
    await editOrSend(env, msg, `Missing title — cancelling.`, tasksMenuKeyboard());
    await clearFlow(env.DB, userId);
    return;
  }

  // Route through the SAME createTask helper /addtask and create_task use.
  const created = await createTask(env.DB, {
    user_id: userId,
    title: s.title,
    priority: s.priority ?? 'C',
    time_estimate_minutes: s.duration ?? null,
  });
  await editOrSend(env, msg, `Added: ${formatTaskLine(created)}`, tasksMenuKeyboard());
  await clearFlow(env.DB, userId);
  return 'added';
}

// ---------------------------------------------------------------
// Edit-task flow — per-step handlers (priority / duration callbacks)
// ---------------------------------------------------------------

interface EditTaskState extends Record<string, unknown> {
  task_id?: number;
  band?: string;
  /**
   * In-progress selection while the user is on the days-of-week
   * toggle grid. Committed to the task on Save (edowok). Kept out
   * of the task row entirely until then.
   */
  days?: WeekdayCode[];
}

/**
 * Merge a single sub-part into the task's existing constraint and
 * write it back via editTask — the SAME helper every other task edit
 * (AI, /schedule, /edittask, other menu fields) funnels through. The
 * `mutate` callback receives the current constraint (may be null) and
 * returns the new one; returning an object with no keys collapses to
 * null so the storage layer clears the row rather than storing `{}`.
 */
async function commitConstraintPart(
  env: Env,
  cq: TelegramCallbackQuery,
  id: number,
  mutate: (current: SchedulingConstraint | null) => SchedulingConstraint,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) {
    await editOrSend(env, msg, `That task is gone.`, tasksMenuKeyboard());
    await clearFlow(env.DB, userId);
    return;
  }
  const current = safeParseStoredConstraint(existing.schedule_constraint);
  const nextRaw = mutate(current);
  // If every sub-key is absent, collapse to null so the field is
  // truly cleared rather than stored as an empty object.
  const hasAny =
    (nextRaw.date_range && (nextRaw.date_range.start || nextRaw.date_range.end))
    || (nextRaw.days_of_week && nextRaw.days_of_week.length > 0)
    || (nextRaw.time_of_day && nextRaw.time_of_day.start && nextRaw.time_of_day.end);
  const next: SchedulingConstraint | null = hasAny ? nextRaw : null;
  const updated = await editTask(env.DB, userId, id, { schedule_constraint: next });
  if (!updated) {
    await editOrSend(env, msg, `No task #${id}.`, tasksMenuKeyboard());
    await clearFlow(env.DB, userId);
    return;
  }
  // Land back on the parts sub-menu so the user can tweak another
  // part without re-entering the field picker. Refresh the header
  // with the newly-saved state so what they see matches reality.
  const refreshed = safeParseStoredConstraint(updated.schedule_constraint);
  await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_part',
    { task_id: id, days: undefined }, msg.message_id);
  await editOrSend(env, msg,
    `Updated: ${formatTaskLine(updated)}\n`
    + `Constraint: ${describeConstraintForMenu(refreshed)}\n\n`
    + `Change another part, or tap Done.`,
    constraintPartsKeyboard(id));
  return 'saved';
}

async function editFlowPriorityBand(
  env: Env, cq: TelegramCallbackQuery, band: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<EditTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'edit_task') return 'no edit-task flow';
  const id = flow.state.task_id;
  if (!id) return 'no task in flow';

  if (band === 'skip') {
    // Skip on edit = keep existing priority. Just close the flow.
    await editOrSend(env, msg, `Priority unchanged.`, tasksMenuKeyboard());
    await clearFlow(env.DB, userId);
    return;
  }
  if (!/^[A-E]$/.test(band)) return 'bad band';
  await advanceFlow<EditTaskState>(env.DB, userId, 'await_priority_fine',
    { band }, msg.message_id);
  await editOrSend(env, msg,
    `Fine-tune ${band}? Pick +, plain, or -.`,
    priorityFineKeyboard('edit', band),
  );
  return;
}

async function editFlowPriorityLetter(
  env: Env, cq: TelegramCallbackQuery, letter: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<EditTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'edit_task') return 'no edit-task flow';
  const id = flow.state.task_id;
  if (!id) return 'no task in flow';

  const updated = await editTask(env.DB, userId, id, { priority: letter });
  if (!updated) {
    await editOrSend(env, msg, `No task #${id}.`, tasksMenuKeyboard());
  } else {
    await editOrSend(env, msg, `Updated: ${formatTaskLine(updated)}`, tasksMenuKeyboard());
  }
  await clearFlow(env.DB, userId);
  return 'done';
}

async function editFlowDuration(
  env: Env, cq: TelegramCallbackQuery, value: string,
): Promise<string | undefined> {
  const msg = cq.message!;
  const userId = cq.from.id;
  const flow = await getFlow<EditTaskState>(env.DB, userId);
  if (!flow || flow.flow !== 'edit_task') return 'no edit-task flow';
  const id = flow.state.task_id;
  if (!id) return 'no task in flow';

  let duration: number | null = null;
  if (value !== 'skip') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return 'bad duration';
    duration = n;
  }
  const updated = await editTask(env.DB, userId, id, { time_estimate_minutes: duration });
  if (!updated) {
    await editOrSend(env, msg, `No task #${id}.`, tasksMenuKeyboard());
  } else {
    await editOrSend(env, msg, `Updated: ${formatTaskLine(updated)}`, tasksMenuKeyboard());
  }
  await clearFlow(env.DB, userId);
  return 'done';
}

// ---------------------------------------------------------------
// Free-text follow-up: called from webhook.ts when the user sends
// a plain text message and has an active flow. Returns true when
// the message was consumed as flow input.
// ---------------------------------------------------------------

export async function tryHandleFlowText(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const flow = await getFlow(env.DB, userId);
  if (!flow) return false;

  // Dispatch by (flow, step).
  if (flow.flow === 'add_task' && flow.step === 'await_title') {
    return await addTaskAwaitTitle(env, msg, flow as FlowState<AddTaskState>, text);
  }
  if (flow.flow === 'edit_task' && flow.step === 'await_title') {
    return await editTaskAwaitTitle(env, msg, flow as FlowState<EditTaskState>, text);
  }
  if (flow.flow === 'edit_task' && flow.step === 'await_when') {
    return await editTaskAwaitWhen(env, msg, flow as FlowState<EditTaskState>, text);
  }
  if (flow.flow === 'edit_task' && flow.step === 'await_constraint_dates') {
    return await editTaskAwaitConstraintDates(env, msg, flow as FlowState<EditTaskState>, text);
  }
  if (flow.flow === 'edit_task' && flow.step === 'await_constraint_time') {
    return await editTaskAwaitConstraintTime(env, msg, flow as FlowState<EditTaskState>, text);
  }
  if (flow.flow === 'tz_other' && flow.step === 'await_iana') {
    return await tzOtherAwait(env, msg, text);
  }
  if (flow.flow === 'currency_other' && flow.step === 'await_code') {
    return await currencyOtherAwait(env, msg, text);
  }
  if (flow.flow === 'balance_add' && flow.step === 'await_amount') {
    return await balanceAddAwait(env, msg, text);
  }
  if (flow.flow === 'balance_set' && flow.step === 'await_amount') {
    return await balanceSetAwait(env, msg, text);
  }
  if (flow.flow === 'setaside_to' && flow.step === 'await_amount') {
    return await setasideToAwait(env, msg, text);
  }
  if (flow.flow === 'setaside_from' && flow.step === 'await_amount') {
    return await setasideFromAwait(env, msg, text);
  }
  return false;
}

async function addTaskAwaitTitle(
  env: Env, msg: TelegramMessage, _flow: FlowState<AddTaskState>, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const title = text.trim();
  if (!title) {
    await sendMessage(env, msg.chat.id, `Title can't be empty. Send it again, or tap Cancel.`);
    return true;
  }
  await advanceFlow<AddTaskState>(env.DB, userId, 'await_priority',
    { title }, null);
  await sendMessage(env, msg.chat.id,
    `Title: ${title}\n\nPriority? (A highest, E lowest)`,
    { replyMarkup: priorityBandKeyboard('add') });
  return true;
}

async function editTaskAwaitTitle(
  env: Env, msg: TelegramMessage, flow: FlowState<EditTaskState>, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const id = flow.state.task_id;
  if (!id) {
    await clearFlow(env.DB, userId);
    return true;
  }
  const title = text.trim();
  if (!title) {
    await sendMessage(env, msg.chat.id, `Title can't be empty.`);
    return true;
  }
  const updated = await editTask(env.DB, userId, id, { title });
  if (!updated) {
    await sendMessage(env, msg.chat.id, `No task #${id}.`);
  } else {
    await sendMessage(env, msg.chat.id, `Updated: ${formatTaskLine(updated)}`);
  }
  await clearFlow(env.DB, userId);
  return true;
}

async function editTaskAwaitConstraintDates(
  env: Env, msg: TelegramMessage, flow: FlowState<EditTaskState>, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const id = flow.state.task_id;
  if (!id) {
    await clearFlow(env.DB, userId);
    return true;
  }
  const trimmed = text.trim();
  const isClear = trimmed === '-' || trimmed === '' ||
    /^(clear|none|off)$/i.test(trimmed);
  // Reuse the SAME parser /schedule and the `constraint=` tag use —
  // wrap the bare value in a `dates:` prefix so a single sub-part
  // reuses the whole-expression validator (dates format, ordering).
  let mutator: ((c: SchedulingConstraint | null) => SchedulingConstraint) | null = null;
  if (isClear) {
    mutator = (c) => {
      const next: SchedulingConstraint = { ...(c ?? {}) };
      delete next.date_range;
      return next;
    };
  } else {
    const parsed = parseConstraintExpression(`dates:${trimmed}`);
    if (!parsed.ok) {
      await sendMessage(env, msg.chat.id,
        `Couldn't read that date range: ${parsed.error}\n\nTry e.g. 2026-08-01..2026-08-15, or send "-" to clear.`);
      return true;
    }
    const dr = parsed.value?.date_range;
    mutator = (c) => {
      const next: SchedulingConstraint = { ...(c ?? {}) };
      if (dr && (dr.start || dr.end)) next.date_range = dr;
      else delete next.date_range;
      return next;
    };
  }
  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) {
    await sendMessage(env, msg.chat.id, `That task is gone.`);
    await clearFlow(env.DB, userId);
    return true;
  }
  const current = safeParseStoredConstraint(existing.schedule_constraint);
  const nextRaw = mutator(current);
  const hasAny =
    (nextRaw.date_range && (nextRaw.date_range.start || nextRaw.date_range.end))
    || (nextRaw.days_of_week && nextRaw.days_of_week.length > 0)
    || (nextRaw.time_of_day && nextRaw.time_of_day.start && nextRaw.time_of_day.end);
  const next: SchedulingConstraint | null = hasAny ? nextRaw : null;
  const updated = await editTask(env.DB, userId, id, { schedule_constraint: next });
  if (!updated) {
    await sendMessage(env, msg.chat.id, `No task #${id}.`);
    await clearFlow(env.DB, userId);
    return true;
  }
  const refreshed = safeParseStoredConstraint(updated.schedule_constraint);
  await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_part',
    { task_id: id }, null);
  await sendMessage(env, msg.chat.id,
    `Updated: ${formatTaskLine(updated)}\n`
    + `Constraint: ${describeConstraintForMenu(refreshed)}\n\n`
    + `Change another part, or tap Done.`,
    { replyMarkup: constraintPartsKeyboard(id) });
  return true;
}

async function editTaskAwaitConstraintTime(
  env: Env, msg: TelegramMessage, flow: FlowState<EditTaskState>, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const id = flow.state.task_id;
  if (!id) {
    await clearFlow(env.DB, userId);
    return true;
  }
  const trimmed = text.trim();
  const isClear = trimmed === '-' || trimmed === '' ||
    /^(clear|none|off)$/i.test(trimmed);
  let mutator: ((c: SchedulingConstraint | null) => SchedulingConstraint) | null = null;
  if (isClear) {
    mutator = (c) => {
      const next: SchedulingConstraint = { ...(c ?? {}) };
      delete next.time_of_day;
      return next;
    };
  } else {
    const parsed = parseConstraintExpression(`time:${trimmed}`);
    if (!parsed.ok) {
      await sendMessage(env, msg.chat.id,
        `Couldn't read that time window: ${parsed.error}\n\nTry e.g. 07:00-08:00, or send "-" to clear.`);
      return true;
    }
    const tw = parsed.value?.time_of_day;
    mutator = (c) => {
      const next: SchedulingConstraint = { ...(c ?? {}) };
      if (tw) next.time_of_day = tw;
      else delete next.time_of_day;
      return next;
    };
  }
  const existing = await getTaskById(env.DB, userId, id);
  if (!existing) {
    await sendMessage(env, msg.chat.id, `That task is gone.`);
    await clearFlow(env.DB, userId);
    return true;
  }
  const current = safeParseStoredConstraint(existing.schedule_constraint);
  const nextRaw = mutator(current);
  const hasAny =
    (nextRaw.date_range && (nextRaw.date_range.start || nextRaw.date_range.end))
    || (nextRaw.days_of_week && nextRaw.days_of_week.length > 0)
    || (nextRaw.time_of_day && nextRaw.time_of_day.start && nextRaw.time_of_day.end);
  const next: SchedulingConstraint | null = hasAny ? nextRaw : null;
  const updated = await editTask(env.DB, userId, id, { schedule_constraint: next });
  if (!updated) {
    await sendMessage(env, msg.chat.id, `No task #${id}.`);
    await clearFlow(env.DB, userId);
    return true;
  }
  const refreshed = safeParseStoredConstraint(updated.schedule_constraint);
  await advanceFlow<EditTaskState>(env.DB, userId, 'await_constraint_part',
    { task_id: id }, null);
  await sendMessage(env, msg.chat.id,
    `Updated: ${formatTaskLine(updated)}\n`
    + `Constraint: ${describeConstraintForMenu(refreshed)}\n\n`
    + `Change another part, or tap Done.`,
    { replyMarkup: constraintPartsKeyboard(id) });
  return true;
}

async function editTaskAwaitWhen(
  env: Env, msg: TelegramMessage, flow: FlowState<EditTaskState>, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const id = flow.state.task_id;
  if (!id) {
    await clearFlow(env.DB, userId);
    return true;
  }
  const trimmed = text.trim();
  const scheduled_for = trimmed === '-' ? null : trimmed;
  const updated = await editTask(env.DB, userId, id, { scheduled_for });
  if (!updated) {
    await sendMessage(env, msg.chat.id, `No task #${id}.`);
  } else {
    await sendMessage(env, msg.chat.id, `Updated: ${formatTaskLine(updated)}`);
  }
  await clearFlow(env.DB, userId);
  return true;
}

async function tzOtherAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const candidate = text.trim().split(/\s+/)[0];
  if (!isValidIanaTimezone(candidate)) {
    await sendMessage(env, msg.chat.id,
      `"${candidate}" isn't a valid IANA timezone. Try something like Africa/Lagos or America/Denver.`);
    return true;
  }
  const before = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
  const after = await setUserTimezone(env.DB, userId, candidate);
  await sendMessage(env, msg.chat.id,
    before === after ? `Timezone stays ${after}.` : `Timezone set: ${before} → ${after}`);
  await clearFlow(env.DB, userId);
  return true;
}

async function currencyOtherAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const code = text.trim().toUpperCase();
  try {
    const applied = await setUserDefaultCurrency(env.DB, userId, code);
    await sendMessage(env, msg.chat.id,
      `Default currency set to ${applied}. Applies to new debts without an explicit currency and to a first-time balance row.`);
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    await sendMessage(env, msg.chat.id, `Couldn't set currency: ${em}`);
  }
  await clearFlow(env.DB, userId);
  return true;
}

async function balanceAddAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const parts = text.trim().split(/\s+/);
  const cents = parseAmountToCents(parts[0]);
  if (cents === null) {
    await sendMessage(env, msg.chat.id, `Couldn't read "${parts[0]}" as an amount. Try again or /menu to cancel.`);
    return true;
  }
  // "Add to balance" is deliberately signed input passthrough — a
  // negative value moves the balance down, matching how the AI's
  // adjust_balance tool behaves.
  const before = await getBalance(env.DB, userId);
  const after = await adjustBalance(env.DB, userId, cents);
  await sendMessage(env, msg.chat.id,
    `Balance: ${formatMoney(before.amount_cents, before.currency)} → ${formatMoney(after.amount_cents, after.currency)}`);
  await clearFlow(env.DB, userId);
  return true;
}

// Same large-overwrite thresholds the AI-side toolExecutor uses. Kept
// in sync by hand — a shared constant would require a light refactor
// of toolExecutor which is out of scope for this part.
const OVERWRITE_CONFIRM_ABS_CENTS = 100_00;
const OVERWRITE_CONFIRM_REL = 0.5;

async function balanceSetAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const parts = text.trim().split(/\s+/);
  const cents = parseAmountToCents(parts[0]);
  if (cents === null) {
    await sendMessage(env, msg.chat.id, `Couldn't read "${parts[0]}" as an amount. Try again or /menu to cancel.`);
    return true;
  }
  const currency = parts[1] ? parts[1].toUpperCase() : undefined;

  const before = await getBalance(env.DB, userId, currency);
  const diff = Math.abs(cents - before.amount_cents);
  const relDiff = before.amount_cents === 0
    ? (cents === 0 ? 0 : 1)
    : diff / Math.abs(before.amount_cents);
  const needsConfirm = diff >= OVERWRITE_CONFIRM_ABS_CENTS && relDiff >= OVERWRITE_CONFIRM_REL;

  if (needsConfirm) {
    // Reuse the SAME pending_confirmations mechanism the AI side uses
    // (createConfirmation + consumeConfirmation, action='overwrite_balance').
    const summary = `Overwrite balance from ${formatMoney(before.amount_cents, before.currency)} to ${formatCents(cents)} ${currency ?? before.currency}`;
    const conf = await createConfirmation(env.DB, userId, 'overwrite_balance',
      { amount_cents: cents, currency }, summary);
    await sendMessage(env, msg.chat.id,
      `${summary}\n\nThat's a big change. Confirm?`,
      { replyMarkup: overwriteConfirmKeyboard(conf.token) });
    await clearFlow(env.DB, userId);
    return true;
  }

  const after = await setBalance(env.DB, userId, cents, currency);
  await sendMessage(env, msg.chat.id,
    `Balance set: ${formatMoney(before.amount_cents, before.currency)} → ${formatMoney(after.amount_cents, after.currency)}`);
  await clearFlow(env.DB, userId);
  return true;
}

async function setasideToAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const cents = parseAmountToCents(text.trim().split(/\s+/)[0] ?? '');
  if (cents === null || cents <= 0) {
    await sendMessage(env, msg.chat.id, `Send a positive amount (e.g. "150"). Or /menu to cancel.`);
    return true;
  }
  const after = await moveToSetAside(env.DB, userId, cents);
  await sendMessage(env, msg.chat.id,
    `Moved ${formatCents(cents)} into set-aside.\n` +
    `Balance: ${formatMoney(after.amount_cents, after.currency)}\n` +
    `Set aside: ${formatMoney(after.set_aside_cents, after.currency)}`);
  await clearFlow(env.DB, userId);
  return true;
}

async function setasideFromAwait(
  env: Env, msg: TelegramMessage, text: string,
): Promise<boolean> {
  const userId = msg.from!.id;
  const cents = parseAmountToCents(text.trim().split(/\s+/)[0] ?? '');
  if (cents === null || cents <= 0) {
    await sendMessage(env, msg.chat.id, `Send a positive amount (e.g. "150"). Or /menu to cancel.`);
    return true;
  }
  const after = await moveFromSetAside(env.DB, userId, cents);
  await sendMessage(env, msg.chat.id,
    `Moved ${formatCents(cents)} back to balance.\n` +
    `Balance: ${formatMoney(after.amount_cents, after.currency)}\n` +
    `Set aside: ${formatMoney(after.set_aside_cents, after.currency)}`);
  await clearFlow(env.DB, userId);
  return true;
}

// ---------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

/**
 * Try to edit the origin message; fall back to sending a fresh one
 * (with the keyboard) if the edit fails. Telegram rejects edits to
 * messages older than 48 hours, or when the content is byte-identical
 * — the second path keeps the UI responsive in either case.
 */
async function editOrSend(
  env: Env, msg: TelegramMessage, text: string, keyboard: InlineKeyboardMarkup,
): Promise<void> {
  const ok = await editMessageText(env, msg.chat.id, msg.message_id, text, {
    replyMarkup: keyboard,
  });
  if (!ok) {
    await sendMessage(env, msg.chat.id, text, { replyMarkup: keyboard });
  }
}

function cancelOnlyKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: '✖️ Cancel', callback_data: '1:flow:cancel' }]] };
}

function formatTaskLine(t: {
  id: number; title: string; priority: number;
  time_estimate_minutes: number | null;
  scheduled_for: string | null; status: string;
}): string {
  const bits = [`#${t.id} ${t.title}`];
  if (t.priority && t.priority !== DEFAULT_PRIORITY_INT) {
    bits.push(`(${priorityIntToLetter(t.priority)})`);
  }
  if (t.time_estimate_minutes && t.time_estimate_minutes > 0) {
    bits.push(`~${t.time_estimate_minutes}min`);
  }
  if (t.scheduled_for) bits.push(`— ${t.scheduled_for}`);
  if (t.status !== 'pending') bits.push(`[${t.status}]`);
  return `• ${bits.join(' ')}`;
}
