// Telegram webhook entry point. Validates the secret header,
// deserialises the update, and dispatches to the agent.

import type { Env } from '../types/env';
import type { TelegramUpdate, TelegramMessage } from '../types/telegram';
import { sendMessage, sendChatAction, getFileMeta, downloadFile } from '../services/telegram';
import { upsertUser } from '../db/users';
import { runAgent } from '../ai/agent';
import { arrayBufferToBase64 } from '../utils/base64';
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

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from) {
    return new Response('ok'); // Ignore non-message updates silently.
  }

  // Return 200 to Telegram immediately, do the work in the background.
  // This prevents Telegram from retrying if Gemini is slow.
  const ctx = (globalThis as any).__ctx as ExecutionContext | undefined;
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

  // Simple slash commands short-circuit the AI to save quota.
  if (msg.text && msg.text.startsWith('/')) {
    if (await handleSlashCommand(env, msg)) return;
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

/** Returns true if handled (and no further AI processing needed). */
async function handleSlashCommand(env: Env, msg: TelegramMessage): Promise<boolean> {
  const cmd = (msg.text ?? '').split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  switch (cmd) {
    case '/start':
      await sendMessage(env, msg.chat.id,
        `Hi — I'm Compass. Tell me what's on your plate, or ask "what should I do now?" whenever you're stuck.\n\n` +
        `I'll remember your open tasks, your recurring habits, and roughly what fits the moment. No pressure, no scolding — just steady help.`,
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
        `• "drop the dentist appointment, don't need it"\n\n` +
        `Voice notes work too.`,
      );
      return true;
    default:
      return false; // Unknown /command falls through to AI.
  }
}

async function safeSendError(env: Env, chatId: number): Promise<void> {
  await sendMessage(env, chatId,
    "Something jammed on my end. Give me a moment and try again.",
  );
}
