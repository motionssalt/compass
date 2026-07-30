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
import { setMyCommands, setWebhook, ALLOWED_UPDATES } from './services/telegram';
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
    // Refresh the Telegram webhook registration so `allowed_updates`
    // matches what this Worker actually handles — in particular that
    // `callback_query` is included so inline-keyboard button taps get
    // delivered. See setWebhook() in src/services/telegram.ts for the
    // full explanation. Safe to re-run at any time.
    if (req.method === 'POST' && url.pathname === '/admin/set-webhook') {
      return handleSetWebhook(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/admin/set-webhook') {
      return handleSetWebhook(req, env);
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
  // Refresh the webhook registration alongside the command list. This
  // is a belt-and-braces fix for the "buttons do nothing" bug: even
  // if an operator only remembers the one legacy `register-commands`
  // hook from the README, a single hit now also re-syncs
  // allowed_updates so callback_query gets delivered. `setWebhook`
  // failing here is treated as a soft warning — the command-menu
  // refresh, which is the endpoint's original job, still succeeds.
  const workerUrl = deriveWorkerBaseUrl(req);
  let webhookInfo: { url: string; allowed_updates: readonly string[] } | null = null;
  let webhookError: string | null = null;
  try {
    webhookInfo = await setWebhook(env, workerUrl);
  } catch (err) {
    webhookError = err instanceof Error ? err.message : String(err);
    log.error('set_webhook_failed_during_register_commands', { err: webhookError });
  }
  try {
    await setMyCommands(env, BOT_COMMANDS);
    return new Response(
      JSON.stringify({
        ok: true,
        registered: BOT_COMMANDS.length,
        webhook: webhookInfo,
        webhook_error: webhookError,
      }),
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

/**
 * Admin endpoint dedicated to re-registering the Telegram webhook
 * with the correct `allowed_updates` list (see setWebhook() for the
 * full explanation of why this exists).
 *
 * Same auth model as `/admin/register-commands`: `x-admin-secret`
 * header or `?secret=` query param, matching TELEGRAM_WEBHOOK_SECRET.
 *
 * By default the Worker URL is derived from the incoming request
 * (so `curl <WORKER_URL>/admin/set-webhook -H "x-admin-secret: ..."`
 * Just Works). An operator can override it by passing `?url=` when
 * the Worker sits behind a custom domain whose incoming Host differs
 * from the URL that Telegram should call.
 */
async function handleSetWebhook(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const provided =
    req.headers.get('x-admin-secret') ?? url.searchParams.get('secret');
  if (!env.TELEGRAM_WEBHOOK_SECRET || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const workerUrl = url.searchParams.get('url')?.trim() || deriveWorkerBaseUrl(req);
  try {
    const info = await setWebhook(env, workerUrl);
    return new Response(
      JSON.stringify({ ok: true, ...info, allowed_updates: ALLOWED_UPDATES }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (err) {
    log.error('set_webhook_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}

/**
 * Best-effort recovery of the Worker's own public base URL from the
 * incoming request, so an operator hitting an admin endpoint doesn't
 * have to plumb the URL through twice. Strips any path/query — the
 * caller (setWebhook) appends the `/telegram` route itself.
 */
function deriveWorkerBaseUrl(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}
