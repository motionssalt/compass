// The tool-calling loop: send message to Gemini, execute any tool
// calls, feed results back, repeat until the model produces plain
// text — that's what we return to the user.

import type { Env } from '../types/env';
import { buildSystemPrompt } from './systemPrompt';
import { generate, type GeminiContent, type GeminiPart } from './gemini';
import { executeTool, type ToolCall } from './toolExecutor';
import { listOpenTasks } from '../db/tasks';
import { resolveUserTimezone, getUserDefaultCurrency } from '../db/users';
import { getBalance } from '../db/balance';
import { listOpenDebts } from '../db/debts';
import { recentMessages, appendMessage, pruneOld } from '../db/conversation';
import { log } from '../utils/logger';

const MAX_TOOL_ROUNDS = 6;

export interface AgentInput {
  userId: number;
  firstName: string | null;
  /** Either a plain text prompt OR audio bytes (from a Telegram voice note). */
  text?: string;
  audio?: { mimeType: string; base64: string };
}

export async function runAgent(env: Env, input: AgentInput): Promise<string> {
  // Stamp the turn once, up front. Everything time-related in this
  // turn is derived from this single instant, so the clock reading the
  // model sees can't drift across the DB round-trips below or
  // disagree with itself over a midnight boundary.
  const now = new Date();
  const { timezone: tz, isExplicit: tzIsExplicit } =
    await resolveUserTimezone(env.DB, input.userId, env.DEFAULT_TIMEZONE);
  const [openTasks, balance, openDebts, defaultCurrency] = await Promise.all([
    listOpenTasks(env.DB, input.userId),
    getBalance(env.DB, input.userId),
    listOpenDebts(env.DB, input.userId),
    getUserDefaultCurrency(env.DB, input.userId),
  ]);
  const systemInstruction = buildSystemPrompt({
    userFirstName: input.firstName,
    timezone: tz,
    timezoneIsExplicit: tzIsExplicit,
    now,
    openTasks,
    balance,
    openDebts,
    defaultCurrency,
  });

  const historyLimit = parseInt(env.CONVERSATION_HISTORY_LIMIT, 10) || 20;
  const history = await recentMessages(env.DB, input.userId, historyLimit);

  const contents: GeminiContent[] = [];

  // Replay recent history (user + model turns only — tool exchanges
  // are ephemeral to the round they occurred in).
  for (const row of history) {
    if (row.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: row.content }] });
    } else if (row.role === 'model') {
      contents.push({ role: 'model', parts: [{ text: row.content }] });
    }
  }

  // The new user turn.
  const userParts: GeminiPart[] = [];
  if (input.audio) {
    userParts.push({
      inlineData: { mimeType: input.audio.mimeType, data: input.audio.base64 },
    });
    // Optional accompanying nudge — Gemini's audio understanding
    // handles this fine on its own, but a hint doesn't hurt.
    userParts.push({ text: '(voice message from user — transcribe intent and respond)' });
  } else {
    userParts.push({ text: input.text ?? '' });
  }
  contents.push({ role: 'user', parts: userParts });

  // Log the user turn immediately so history stays intact even if
  // Gemini errors out mid-loop. For audio, we log a placeholder.
  await appendMessage(
    env.DB,
    input.userId,
    'user',
    input.audio ? '[voice message]' : (input.text ?? ''),
  );

  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await generate(env, contents, systemInstruction);
    const candidate = resp.candidates?.[0];
    const modelContent = candidate?.content;
    if (!modelContent) {
      finalText = "I'm here — could you say that again?";
      break;
    }

    // Push the model turn back into contents so the follow-up call
    // has full context.
    contents.push(modelContent);

    const toolCalls: ToolCall[] = [];
    let textChunk = '';
    for (const part of modelContent.parts ?? []) {
      if (part.functionCall) {
        toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
      } else if (part.text) {
        textChunk += part.text;
      }
    }

    if (toolCalls.length === 0) {
      finalText = textChunk.trim() ||
        "Sorry, I lost my train of thought there — try rephrasing or send that again?";
      break;
    }

    // Execute every tool call from this round in order.
    const toolParts: GeminiPart[] = [];
    for (const call of toolCalls) {
      const result = await executeTool(env, input.userId, call);
      log.info('tool_called', { tool: call.name, ok: (result.response as any).ok });
      toolParts.push({
        functionResponse: { name: result.name, response: result.response },
      });
    }
    contents.push({ role: 'function', parts: toolParts });
    // Loop: let the model use the tool results to produce a reply.
  }

  if (!finalText) {
    finalText = "I hit a snag thinking that through. Try again in a moment?";
  }

  await appendMessage(env.DB, input.userId, 'model', finalText);
  // Keep the log from ballooning.
  await pruneOld(env.DB, input.userId, historyLimit * 3);

  return finalText;
}
