-- Motionsalt Compass — initial schema.
--
-- All timestamps are stored as ISO-8601 UTC strings (TEXT). Booleans
-- are 0/1 INTEGERs. IDs are AUTOINCREMENT integers except where noted.

-- ---------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,          -- Telegram user id
  title            TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','in_progress','done','cancelled')),
  priority         INTEGER NOT NULL DEFAULT 3, -- 1 highest, 5 lowest
  context_note     TEXT,                       -- why it matters / when relevant
  scheduled_for    TEXT,                       -- ISO datetime OR loose text ("morning")
  is_recurring     INTEGER NOT NULL DEFAULT 0,
  recurrence_rule  TEXT,                       -- JSON: {"freq":"daily"} or {"freq":"weekly","days":["mon","wed"]}
  last_completed_at TEXT,
  cancel_reason    TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status
  ON tasks (user_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_user_recurring
  ON tasks (user_id, is_recurring);

-- ---------------------------------------------------------------
-- api_keys — pool of Gemini API keys with round-robin + fallback
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  key_value           TEXT    NOT NULL UNIQUE,
  daily_quota         INTEGER NOT NULL DEFAULT 1500,
  used_today          INTEGER NOT NULL DEFAULT 0,
  last_reset_date     TEXT    NOT NULL DEFAULT (date('now')),
  is_active           INTEGER NOT NULL DEFAULT 1,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  last_error_message  TEXT,
  last_used_at        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active_lru
  ON api_keys (is_active, last_used_at);

-- ---------------------------------------------------------------
-- conversation_log — short rolling context per user
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('user','model','tool')),
  content    TEXT    NOT NULL,       -- plain text for user/model; JSON for tool responses
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_user_time
  ON conversation_log (user_id, created_at DESC);

-- ---------------------------------------------------------------
-- users — lightweight per-user prefs (timezone override etc.)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,        -- Telegram user id
  first_name  TEXT,
  username    TEXT,
  timezone    TEXT,                        -- e.g. "Africa/Nairobi"; null = use default
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
