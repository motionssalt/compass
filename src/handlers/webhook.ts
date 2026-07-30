// Telegram webhook entry point. Validates the secret header,
// deserialises the update, and dispatches to the agent.

import type { Env } from '../types/env';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery } from '../types/telegram';
import { sendMessage, sendChatAction, getFileMeta, downloadFile, answerCallbackQuery } from '../services/telegram';
import { upsertUser, getUserTimezone, setUserTimezone, isValidIanaTimezone } from '../db/users';
import { listTasksByFilter } from '../db/tasks';
import { getBalance, setBalance } from '../db/balance';
import { listOpenDebts } from '../db/debts';
import { rememberChatId } from '../db/nudge';
import { parseAmountToCents, formatMoney } from '../utils/money';
import { priorityIntToLetter, DEFAULT_PRIORITY_INT } from '../utils/priority';
import { runAgent } from '../ai/agent';
import { arrayBufferToBase64 } from '../utils/base64';
import {
  cmdAddTask, cmdAddBatch, cmdEditTask, cmdReviewFlexible,
} from './directTasks';
import {
  processCallbackQuery, openMenu, tryHandleFlowText,
} from './buttons';
import { log } from '../utils/logger';

const TG_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const provided = req.headers.get(TG_SECRET_HEADER);
  if (!env.TELEGRAM_WEBHOOK_SECRET || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const ctx = (globalThis as any).__ctx as ExecutionContext | undefined;

  // Route by update type. Both branches follow the same "return 200
  // to Telegram immediately, do the work in the background" pattern
  // so a slow branch never causes Telegram to retry.

  if (update.callback_query) {
    const cq = update.callback_query;
    const work = processCallbackQuery(env, cq).catch(async (err) => {
      log.error('processCallbackQuery failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Always answer the callback, even on total failure, so the
      // user's tap doesn't hang with a loading spinner.
      await answerCallbackQuery(env, cq.id, 'Something jammed. Try /menu again.').catch(() => {});
      const chatId = cq.message?.chat.id;
      if (chatId !== undefined) {
        await safeSendError(env, chatId).catch(() => {});
      }
    });
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
    return new Response('ok');
  }

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from) {
    return new Response('ok'); // Ignore anything else (e.g. channel posts).
  }

  const work = processMessage(env, msg).catch((err) => {
    log.error('processMessage failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return safeSendError(env, msg.chat.id).catch(() => {});
  });

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;

  return new Response('ok');
}

async function processMessage(env: Env, msg: TelegramMessage): Promise<void> {
  const from = msg.from!;
  await upsertUser(env.DB, from.id, from.first_name ?? null, from.username ?? null);
  // Capture the chat_id so the free-window nudge cron has a
  // destination for outbound messages. Private chats have
  // chat_id == user_id, but stashing it explicitly makes the
  // assumption auditable.
  await rememberChatId(env.DB, from.id, msg.chat.id);

  // Simple slash commands short-circuit the AI to save quota.
  if (msg.text && msg.text.startsWith('/')) {
    if (await handleSlashCommand(env, msg)) return;
  }

  // If a button-driven flow is waiting on the user's next free-text
  // reply, consume the message here (no AI, no direct-command path).
  // This runs AFTER the slash-command dispatch above, so a user can
  // always break out of a stuck flow with /menu or any other slash.
  if (msg.text && !msg.text.startsWith('/')) {
    const consumed = await tryHandleFlowText(env, msg, msg.text);
    if (consumed) return;
  }

  await sendChatAction(env, msg.chat.id, 'typing');

  let reply: string;
  if (msg.voice || msg.audio) {
    const media = msg.voice ?? msg.audio!;
    const meta = await getFileMeta(env, media.file_id);
    if (!meta.file_path) throw new Error('telegram returned no file_path');
    const buf = await downloadFile(env, meta.file_path);
    const b64 = arrayBufferToBase64(buf);
    // Telegram voice notes are OGG/Opus — Gemini accepts audio/ogg
    // directly, no transcoding step needed.
    const mimeType = media.mime_type ?? 'audio/ogg';
    reply = await runAgent(env, {
      userId: from.id,
      firstName: from.first_name ?? null,
      audio: { mimeType, base64: b64 },
    });
  } else if (msg.text) {
    reply = await runAgent(env, {
      userId: from.id,
      firstName: from.first_name ?? null,
      text: msg.text,
    });
  } else {
    reply = "I can read text and voice notes — send me one of those and I'll pick it up.";
  }

  await sendMessage(env, msg.chat.id, reply);
}

/**
 * Returns true if handled (and no further AI processing needed).
 *
 * These direct-read fast paths deliberately skip Gemini so that
 * cheap, high-frequency reads/edits ("show my balance", "today's
 * tasks", "set balance to 500") don't burn API quota. AI-driven
 * updates against the same underlying data (via runAgent) remain
 * fully available in normal conversation.
 */
async function handleSlashCommand(env: Env, msg: TelegramMessage): Promise<boolean> {
  const raw = (msg.text ?? '').trim();
  const cmd = raw.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const argStr = raw.slice(raw.indexOf(cmd) + cmd.length).trim();
  const userId = msg.from!.id;

  switch (cmd) {
    case '/start':
      await sendMessage(env, msg.chat.id,
        `Hi — I'm Compass. Tell me what's on your plate, or ask "what should I do now?" whenever you're stuck.\n\n` +
        `I track your open tasks, your recurring habits, your running balance, and the debts you owe (or that you're just holding cash for). ` +
        `When money arrives, tell me and I'll suggest exactly what to do with it. No pressure, no scolding — just steady help.\n\n` +
        `Try /help to see quick commands, or /menu to drive me by buttons.`,
      );
      return true;

    case '/help':
      await sendMessage(env, msg.chat.id,
        `Just talk to me normally. Some things you can try:\n` +
        `• "I need to submit the report by Friday"\n` +
        `• "add daily Bible study as a recurring task"\n` +
        `• "what should I do now?"\n` +
        `• "I'm tired — anything light?"\n` +
        `• "I'm done with the groceries"\n` +
        `• "I just got paid 500"\n` +
        `• "I owe my landlord 800 by the 5th"\n` +
        `• "that 300 is my mom's, I'm just holding it"\n\n` +
        `Quick commands (no AI, no quota):\n` +
        `/today — today's tasks\n` +
        `/balance — current balance\n` +
        `/debts — open debts\n` +
        `/finance — balance + debts summary\n` +
        `/setbalance <amount> [currency] — overwrite the balance directly\n` +
        `/timezone <IANA tz> — set your timezone (e.g. Africa/Lagos)\n` +
        `/menu — button-driven access to tasks, finance, and settings\n\n` +
        `Voice notes work too.`,
      );
      return true;

    case '/menu':
    case '/settings': {
      // /menu is the canonical entry point; /settings is a familiar
      // alias for the same top-level keyboard (the Settings submenu
      // is one tap in).
      await openMenu(env, msg.chat.id);
      return true;
    }

    case '/today': {
      const tz = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
      const tasks = await listTasksByFilter(env.DB, userId, 'today', tz);
      if (tasks.length === 0) {
        await sendMessage(env, msg.chat.id, `Nothing on today's list. If something comes up, just tell me.`);
        return true;
      }
      const lines = tasks.map((t) => {
        const prefix = t.status === 'in_progress' ? '▶' : '•';
        const bits = [`${prefix} #${t.id} ${t.title}`];
        if (t.priority && t.priority !== DEFAULT_PRIORITY_INT) {
          bits.push(`(${priorityIntToLetter(t.priority)})`);
        }
        if (t.scheduled_for) bits.push(`— ${t.scheduled_for}`);
        return bits.join(' ');
      });
      await sendMessage(env, msg.chat.id, `Today:\n${lines.join('\n')}`);
      return true;
    }

    case '/balance': {
      const bal = await getBalance(env.DB, userId);
      await sendMessage(env, msg.chat.id, `Balance: ${formatMoney(bal.amount_cents, bal.currency)}`);
      return true;
    }

    case '/debts': {
      const debts = await listOpenDebts(env.DB, userId);
      if (debts.length === 0) {
        await sendMessage(env, msg.chat.id, `No open debts.`);
        return true;
      }
      const lines = debts.map((d) => {
        const who = d.responsible_party === 'other'
          ? ` [holding for ${d.on_behalf_of ?? 'someone else'}]`
          : '';
        const due = d.due ? ` — due ${d.due}` : '';
        const urg = d.urgency && d.urgency !== DEFAULT_PRIORITY_INT
          ? ` (${priorityIntToLetter(d.urgency)})`
          : '';
        return `• #${d.id} ${d.creditor}: ${formatMoney(d.amount_cents, d.currency)}${who}${due}${urg}`;
      });
      await sendMessage(env, msg.chat.id, `Open debts:\n${lines.join('\n')}`);
      return true;
    }

    case '/finance': {
      const [bal, debts] = await Promise.all([
        getBalance(env.DB, userId),
        listOpenDebts(env.DB, userId),
      ]);
      const parts = [`Balance: ${formatMoney(bal.amount_cents, bal.currency)}`];
      // Split totals so the user sees the "your own" number clearly.
      const userDebts = debts.filter((d) => d.responsible_party === 'user');
      const otherDebts = debts.filter((d) => d.responsible_party === 'other');
      const sum = (arr: typeof debts) => arr.reduce((a, d) => a + d.amount_cents, 0);
      if (userDebts.length) {
        parts.push(`You owe: ${formatMoney(sum(userDebts), bal.currency)} across ${userDebts.length} debt${userDebts.length === 1 ? '' : 's'}`);
      }
      if (otherDebts.length) {
        parts.push(`Holding for others: ${formatMoney(sum(otherDebts), bal.currency)} across ${otherDebts.length}`);
      }
      if (debts.length === 0) parts.push(`No open debts.`);
      else {
        parts.push('');
        for (const d of debts) {
          const who = d.responsible_party === 'other'
            ? ` [for ${d.on_behalf_of ?? 'someone else'}]`
            : '';
          const due = d.due ? ` — due ${d.due}` : '';
          parts.push(`• #${d.id} ${d.creditor}: ${formatMoney(d.amount_cents, d.currency)}${who}${due}`);
        }
      }
      await sendMessage(env, msg.chat.id, parts.join('\n'));
      return true;
    }

    case '/addtask':
    case '/add': {
      const reply = await cmdAddTask(env, userId, argStr);
      await sendMessage(env, msg.chat.id, reply);
      return true;
    }

    case '/addbatch':
    case '/batch': {
      const reply = await cmdAddBatch(env, userId, argStr);
      await sendMessage(env, msg.chat.id, reply);
      return true;
    }

    case '/edittask':
    case '/edit': {
      const reply = await cmdEditTask(env, userId, argStr);
      await sendMessage(env, msg.chat.id, reply);
      return true;
    }

    case '/flex':
    case '/flexible':
    case '/review': {
      const reply = await cmdReviewFlexible(env, userId);
      await sendMessage(env, msg.chat.id, reply);
      return true;
    }

    case '/timezone':
    case '/tz': {
      // Usage: /timezone <IANA tz name>
      // Direct edit — no AI, no confirmation. Same trust model as
      // /setbalance: if the user typed the command themselves, they
      // meant it. Rejects anything that isn't a real IANA identifier
      // so the daily-rollover logic that reads this column stays sane.
      if (!argStr) {
        const current = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
        await sendMessage(env, msg.chat.id,
          `Usage: /timezone <IANA tz name>\nExample: /timezone America/New_York\nExample: /timezone Africa/Lagos\n\nCurrent: ${current}`);
        return true;
      }
      // Take only the first whitespace-separated token — timezone
      // identifiers never contain spaces, so anything after is user
      // noise we don't want to feed into validation.
      const candidate = argStr.split(/\s+/)[0];
      if (!isValidIanaTimezone(candidate)) {
        await sendMessage(env, msg.chat.id,
          `"${candidate}" isn't a valid IANA timezone. Try something like /timezone America/New_York or /timezone Africa/Lagos.`);
        return true;
      }
      const before = await getUserTimezone(env.DB, userId, env.DEFAULT_TIMEZONE);
      const after = await setUserTimezone(env.DB, userId, candidate);
      await sendMessage(env, msg.chat.id,
        before === after
          ? `Timezone stays ${after}.`
          : `Timezone set: ${before} → ${after}`,
      );
      return true;
    }

    case '/setbalance': {
      // Usage: /setbalance <amount> [currency]
      // Direct edit — deliberately does NOT go through the AI's
      // confirm-large-overwrite gate. If the user typed the command
      // themselves, they meant it.
      if (!argStr) {
        await sendMessage(env, msg.chat.id,
          `Usage: /setbalance <amount> [currency]\nExample: /setbalance 1234.50\nExample: /setbalance 500 KES`);
        return true;
      }
      const parts = argStr.split(/\s+/);
      const cents = parseAmountToCents(parts[0]);
      if (cents === null) {
        await sendMessage(env, msg.chat.id, `Couldn't read "${parts[0]}" as an amount. Try /setbalance 1234.50`);
        return true;
      }
      const currency = parts[1] ? parts[1].toUpperCase() : undefined;
      const before = await getBalance(env.DB, userId);
      const after = await setBalance(env.DB, userId, cents, currency);
      await sendMessage(env, msg.chat.id,
        `Balance set: ${formatMoney(before.amount_cents, before.currency)} → ${formatMoney(after.amount_cents, after.currency)}`,
      );
      return true;
    }

    default:
      return false; // Unknown /command falls through to AI.
  }
}

async function safeSendError(env: Env, chatId: number): Promise<void> {
  await sendMessage(env, chatId,
    "Something jammed on my end. Give me a moment and try again.",
  );
}
