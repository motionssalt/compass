// Gemini client with automatic API-key fallback.
//
// We speak the REST v1beta "generateContent" endpoint directly so we
// don't need to ship the @google/generative-ai SDK (keeps the Worker
// bundle small). Function-calling and inline audio input are both
// supported through this endpoint.

import type { Env } from '../types/env';
import { pickActiveKeys, markKeyUsed, markKeyError } from '../db/apiKeys';
import { TOOL_DECLARATIONS } from './tools';
import { log } from '../utils/logger';

// ---------------------------------------------------------------
// Content shape (a tiny subset of Gemini's API)
// ---------------------------------------------------------------

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string }; // base64
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
}

// ---------------------------------------------------------------
// Public call
// ---------------------------------------------------------------

export async function generate(
  env: Env,
  contents: GeminiContent[],
  systemInstruction: string,
): Promise<GeminiResponse> {
  const keys = await pickActiveKeys(env.DB);
  if (keys.length === 0) {
    throw new Error('No active Gemini API keys available. Add some to the api_keys table.');
  }

  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    contents,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    // Let Gemini decide when to call tools vs respond in text.
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      // Raised from 1024: on gemini-3.1-flash-lite, "thinking" tokens are
      // deducted from this same budget. At 1024 the model would
      // sometimes burn the whole budget thinking and hit MAX_TOKENS
      // before writing any visible text, causing the "OK." fallback.
      maxOutputTokens: 2048,
      // Cap (don't fully disable — 2.5-flash tool-calling benefits
      // from some reasoning) thinking tokens so they can't crowd out
      // the actual reply.
      thinkingConfig: { thinkingBudget: 512 },
    },
  };

  let lastError = 'unknown error';
  for (const key of keys) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}` +
      `:generateContent?key=${encodeURIComponent(key.key_value)}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      lastError = `network: ${netErr instanceof Error ? netErr.message : String(netErr)}`;
      await markKeyError(env.DB, key.id, lastError);
      continue;
    }

    if (resp.status === 200) {
      const json = (await resp.json()) as GeminiResponse;
      // Some safety blocks come back 200 with no candidates.
      if (!json.candidates || json.candidates.length === 0) {
        lastError = `empty candidates${json.promptFeedback?.blockReason ? ' — blocked: ' + json.promptFeedback.blockReason : ''}`;
        await markKeyError(env.DB, key.id, lastError);
        continue;
      }
      await markKeyUsed(env.DB, key.id);
      return json;
    }

    // Retryable / rotate to next key.
    const errText = await safeReadText(resp);
    lastError = `HTTP ${resp.status}: ${errText.slice(0, 300)}`;
    log.warn('gemini_call_failed', { key_id: key.id, status: resp.status, err: lastError });

    if (resp.status === 429 || resp.status === 403) {
      // Quota / disabled — burn this key hard and try next.
      await markKeyError(env.DB, key.id, lastError, /* disable */ true);
    } else if (resp.status >= 500) {
      await markKeyError(env.DB, key.id, lastError);
    } else if (resp.status === 400) {
      // 400 is usually our fault, not the key's — don't rotate.
      throw new Error(`Gemini rejected request: ${lastError}`);
    } else {
      await markKeyError(env.DB, key.id, lastError);
    }
  }

  throw new Error(`All Gemini keys failed. Last error: ${lastError}`);
}

async function safeReadText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ''; }
}
