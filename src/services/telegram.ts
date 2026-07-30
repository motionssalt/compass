// Thin Telegram Bot API wrapper — only the calls we actually use.

import type { Env } from '../types/env';
import type { TelegramFile, InlineKeyboardMarkup } from '../types/telegram';
import type { BotCommand } from '../handlers/commandMenu';

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Send a plain text message. If `replyMarkup` is provided (inline
 * keyboard), it's attached to the FIRST chunk only — a keyboard
 * belongs on the terminal message of a conversation turn, not on
 * every 4000-char slice. Returns the Telegram message_id of the
 * first chunk on success (useful when the caller wants to
 * editMessageText the same message later), or null when the send
 * fails softly.
 */
export async function sendMessage(
  env: Env, chatId: number, text: string,
  opts?: { replyMarkup?: InlineKeyboardMarkup },
): Promise<number | null> {
  // Telegram caps messages at 4096 chars. Chunk if we ever exceed.
  const chunks = chunkText(text, 4000);
  let firstMsgId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
    if (i === 0 && opts?.replyMarkup) body.reply_markup = opts.replyMarkup;
    const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`sendMessage failed: ${resp.status} ${errBody}`);
    }
    if (i === 0) {
      try {
        const json = await resp.json() as { ok: boolean; result?: { message_id?: number } };
        if (json.ok && json.result?.message_id) firstMsgId = json.result.message_id;
      } catch { /* ignore parse failure — send still succeeded */ }
    }
  }
  return firstMsgId;
}

/**
 * Edit an already-sent message's text (and optionally its inline
 * keyboard). Used to step a menu / flow prompt through its stages
 * in-place instead of spamming the chat with a new message per tap.
 *
 * Errors are swallowed and reported via the return value so the
 * caller can fall back to sendMessage. Telegram rejects an edit that
 * results in identical content ("message is not modified") — that's
 * treated as success here since the visible state is what we wanted.
 */
export async function editMessageText(
  env: Env, chatId: number, messageId: number, text: string,
  opts?: { replyMarkup?: InlineKeyboardMarkup },
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (opts?.replyMarkup) body.reply_markup = opts.replyMarkup;
  const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'editMessageText'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.ok) return true;
  // "message is not modified" surfaces as 400 — treat as no-op success.
  const errBody = await resp.text().catch(() => '');
  if (/message is not modified/i.test(errBody)) return true;
  return false;
}

/**
 * Acknowledge a callback_query so the button's loading spinner on
 * the client stops. MUST be called for every callback update, even
 * on error — otherwise the tap looks stuck to the user.
 *
 * `text`, when provided, appears as a small toast; keep it short
 * (Telegram caps ~200 chars). Errors are swallowed — this is a
 * best-effort call.
 */
export async function answerCallbackQuery(
  env: Env, callbackQueryId: string, text?: string, showAlert?: boolean,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body.text = text.slice(0, 200);
  if (showAlert) body.show_alert = true;
  await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* non-fatal */ });
}

export async function sendChatAction(
  env: Env, chatId: number, action: 'typing' | 'record_voice',
): Promise<void> {
  await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendChatAction'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => { /* non-fatal */ });
}

/** Resolve a Telegram file_id to a downloadable file_path. */
export async function getFileMeta(env: Env, fileId: string): Promise<TelegramFile> {
  const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'getFile'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const json = await resp.json() as { ok: boolean; result?: TelegramFile; description?: string };
  if (!json.ok || !json.result) {
    throw new Error(`getFile failed: ${json.description ?? 'unknown'}`);
  }
  return json.result;
}

/** Download the actual bytes of a Telegram file. */
export async function downloadFile(env: Env, filePath: string): Promise<ArrayBuffer> {
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`downloadFile failed: ${resp.status}`);
  return await resp.arrayBuffer();
}

/**
 * Register the bot's direct slash commands with Telegram so they
 * appear in the built-in command menu (the "/" button UI on
 * Telegram clients).
 *
 * Idempotent — Telegram treats this as a full replacement of the
 * default-scope command list, so calling it repeatedly with the
 * same input converges. Intended to run once per deploy from the
 * admin init endpoint (see src/index.ts). Not wired into a cron;
 * this list changes only when the code changes.
 */
export async function setMyCommands(
  env: Env, commands: readonly BotCommand[],
): Promise<void> {
  const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'setMyCommands'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No `scope` / `language_code` — default scope covers all private
    // chats and all locales, which is what we want for a personal bot.
    body: JSON.stringify({ commands }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`setMyCommands failed: ${resp.status} ${body}`);
  }
  const json = await resp.json() as { ok: boolean; description?: string };
  if (!json.ok) {
    throw new Error(`setMyCommands rejected: ${json.description ?? 'unknown'}`);
  }
}

/**
 * The full list of update types this Worker actually handles. Kept as
 * a single exported constant so the admin `setWebhook` hook and the
 * README example can't drift apart.
 *
 * `callback_query` is REQUIRED for the inline-keyboard menu in
 * src/handlers/buttons.ts — without it Telegram silently drops every
 * button tap, and the /menu keyboard looks alive but does nothing.
 * The bug that motivated this helper was exactly that: an existing
 * deployment had its webhook registered with only
 * ["message", "edited_message"] (a natural default before the button
 * menu existed), and once Telegram has a non-empty allowed_updates on
 * file it does NOT re-derive it from anywhere — it stays that way
 * until an explicit setWebhook overwrites it.
 */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
] as const;

/**
 * Register (or re-register) the Telegram webhook so it points at
 * `<workerUrl>/telegram`, is guarded by the bot's shared secret, and
 * — critically — has `callback_query` in its `allowed_updates` list.
 *
 * Idempotent: Telegram treats a repeat `setWebhook` with the same URL
 * as a no-op (except for updating the allowed_updates / secret_token
 * fields, which is exactly what we want here — that's the whole point
 * of exposing this as a re-runnable admin action).
 *
 * `workerUrl` should be the base URL of the deployed Worker (no path,
 * no trailing slash). We append `/telegram` here since the routing
 * table in src/index.ts owns that path.
 */
export async function setWebhook(
  env: Env, workerUrl: string,
): Promise<{ url: string; allowed_updates: readonly string[] }> {
  const base = workerUrl.replace(/\/+$/, '');
  const webhookUrl = `${base}/telegram`;
  const payload = {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    // Full replacement — Telegram stores this list verbatim and will
    // silently drop any update type that isn't in it, so we must
    // enumerate every type the Worker actually handles.
    allowed_updates: ALLOWED_UPDATES,
    // Fresh start: discard anything Telegram was holding under the
    // old (broken) allowed_updates so button taps that piled up
    // during the outage don't replay after the fix.
    drop_pending_updates: true,
  };
  const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`setWebhook failed: ${resp.status} ${body}`);
  }
  const json = await resp.json() as { ok: boolean; description?: string };
  if (!json.ok) {
    throw new Error(`setWebhook rejected: ${json.description ?? 'unknown'}`);
  }
  return { url: webhookUrl, allowed_updates: ALLOWED_UPDATES };
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}
