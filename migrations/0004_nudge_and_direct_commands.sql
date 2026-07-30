-- Motionsalt Compass — duration-aware free-time nudging + fairness.
--
-- Same conventions as prior migrations:
--   * ISO-8601 UTC TEXT timestamps
--   * booleans as 0/1 INTEGERs
--   * IDs are AUTOINCREMENT INTEGER
--
-- Nothing here is destructive — every column and table is additive
-- and defaults to a sane empty/null value, so the new nudge cron can
-- run against an unmigrated row set without misbehaving.

-- ---------------------------------------------------------------
-- tasks.last_nudged_at
-- ---------------------------------------------------------------
-- When the free-time nudger picks a flexible task, it stamps this
-- column. The nudge scorer then penalises recently-nudged tasks so
-- the user isn't shown the same one over and over.
ALTER TABLE tasks ADD COLUMN last_nudged_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_user_last_nudged
  ON tasks (user_id, last_nudged_at);

-- ---------------------------------------------------------------
-- user_nudge_state — one row per user, tracks the current free window
-- ---------------------------------------------------------------
-- We nudge at most ONCE per free window. A free window is identified
-- by a short signature derived from "what's currently scheduled /
-- in-progress"; when that signature changes (a task started, a slot
-- opened up, etc.) a new window begins and a new nudge is allowed.
--
-- `chat_id` is captured on the user's most recent message and used
-- as the outbound target for the nudge — for private Telegram chats
-- this always equals the user id, but we store it explicitly so the
-- assumption is auditable and easy to change if a group ever gets
-- wired in.
CREATE TABLE IF NOT EXISTS user_nudge_state (
  user_id                INTEGER PRIMARY KEY,       -- Telegram user id
  chat_id                INTEGER,                    -- last-known private chat id
  last_window_signature  TEXT,                       -- opaque hash of "current busy set"
  last_nudge_at          TEXT,                       -- ISO timestamp of last nudge sent
  last_nudged_task_id    INTEGER,                    -- fk-ish; not enforced
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
