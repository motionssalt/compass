// Worker entry point. Three triggers:
//   - fetch     (Telegram webhook)
//   - scheduled (daily cron @ 00:05 UTC)
//   - scheduled (free-time nudger @ */15 min)
//
// Cloudflare fires a single `scheduled` handler for every cron
// trigger declared in wrangler.toml; we route based on `event.cron`.

import type { Env } from './types/env';
import { handleWebhook } from './handlers/webhook';
import { handleCron } from './handlers/cron';
import { handleNudgeCron } from './handlers/nudgeCron';
import { log } from './utils/logger';

// Cron patterns — keep in sync with wrangler.toml [triggers].crons.
const CRON_DAILY = '5 0 * * *';
const CRON_NUDGE = '*/15 * * * *';

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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;

    if (cron === CRON_NUDGE) {
      ctx.waitUntil(handleNudgeCron(env).catch((err) => {
        log.error('cron_nudge_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }));
      return;
    }

    // Default / daily reset. Fires for the daily pattern and for any
    // hypothetical extra trigger we haven't specifically routed —
    // safer to run the daily housekeeping too often than skip it.
    ctx.waitUntil(handleCron(env).catch((err) => {
      log.error('cron_daily_failed', {
        cron,
        err: err instanceof Error ? err.message : String(err),
      });
    }));
  },
};
