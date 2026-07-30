// Thin Telegram Bot API wrapper — only the calls we actually use.

import type { Env } from '../types/env';
import type { TelegramFile } from '../types/telegram';
import type { BotCommand } from '../handlers/commandMenu';

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function sendMessage(
  env: Env, chatId: number, text: string,
): Promise<void> {
  // Telegram caps messages at 4096 chars. Chunk if we ever exceed.
  const chunks = chunkText(text, 4000);
  for (const chunk of chunks) {
    const resp = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`sendMessage failed: ${resp.status} ${body}`);
    }
  }
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
