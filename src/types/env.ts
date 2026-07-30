// Bindings and environment variables exposed to the Worker.
// Everything sensitive lives in encrypted secrets, not [vars].

export interface Env {
  // ---- D1 ----
  DB: D1Database;

  // ---- Non-secret vars (wrangler.toml [vars]) ----
  DEFAULT_TIMEZONE: string;
  GEMINI_MODEL: string;
  CONVERSATION_HISTORY_LIMIT: string;

  // ---- Secrets (set via Cloudflare dashboard) ----
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}
