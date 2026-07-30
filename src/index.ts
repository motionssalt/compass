// Worker entry point. Two triggers:
//   - fetch (Telegram webhook)
//   - scheduled (daily cron @ 00:05 UTC)

import type { Env } from './types/env';
import { handleWebhook } from './handlers/webhook';
import { handleCron } from './handlers/cron';
import { log } from './utils/logger';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Stash ctx on globalThis so the webhook handler can waitUntil.
    (globalThis as any).__ctx = ctx;

    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/telegram') {
      return handleWebhook(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response('Motionsalt Compass is alive.', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env).catch((err) => {
      log.error('cron_failed', { err: err instanceof Error ? err.message : String(err) });
    }));
  },
};
