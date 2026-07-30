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
import { setMyCommands } from './services/telegram';
import { BOT_COMMANDS } from './handlers/commandMenu';
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
    // One-off post-deploy hook. Sits alongside the manual
    // `setWebhook` curl the README documents — same trust model:
    // guarded by TELEGRAM_WEBHOOK_SECRET, hit it once per deploy
    // (e.g. `curl -H "x-admin-secret: <SECRET>" <WORKER_URL>/admin/register-commands`)
    // and Telegram's command menu is refreshed. No cron, no
    // persistent state — setMyCommands is idempotent, so it's safe
    // to call again whenever the direct-command list changes.
    if (req.method === 'POST' && url.pathname === '/admin/register-commands') {
      return handleRegisterCommands(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/admin/register-commands') {
      return handleRegisterCommands(req, env);
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

/**
 * Admin init endpoint: refresh Telegram's command menu from
 * BOT_COMMANDS. Reuses TELEGRAM_WEBHOOK_SECRET as the shared admin
 * secret so we don't introduce a new credential just for this. Send
 * it either as `x-admin-secret` header or `?secret=` query param.
 */
async function handleRegisterCommands(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const provided =
    req.headers.get('x-admin-secret') ?? url.searchParams.get('secret');
  if (!env.TELEGRAM_WEBHOOK_SECRET || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    await setMyCommands(env, BOT_COMMANDS);
    return new Response(
      JSON.stringify({ ok: true, registered: BOT_COMMANDS.length }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (err) {
    log.error('register_commands_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
