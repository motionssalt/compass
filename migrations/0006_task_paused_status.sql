-- Motionsalt Compass — extend tasks.status with 'paused'.
--
-- Same conventions as prior migrations:
--   * ISO-8601 UTC TEXT timestamps
--   * booleans as 0/1 INTEGERs
--   * IDs are AUTOINCREMENT INTEGER
--
-- Background. A paused task is one the user has parked for now — still
-- on the list, but explicitly excluded from the free-time nudger and
-- from the "what's currently active?" check. It is NOT a done/cancelled
-- task (the user still intends to come back to it), and it is NOT a
-- regular pending task (nudging about it would be obnoxious). The new
-- 'paused' enum value covers that middle ground.
--
-- Why this migration is structurally a rebuild.
--   SQLite has no `ALTER TABLE ... DROP CONSTRAINT`. Extending the CHECK
--   constraint to admit a new value requires the rename-rebuild dance:
--     create tasks_new with the broader CHECK
--     copy all rows verbatim (no value would not be accepted by either
--       constraint, so no per-row normalisation is necessary here)
--     drop tasks, rename tasks_new -> tasks
--     recreate indexes (they live on table name, not table identity)
--
--   All rows including their last_nudged_at fairness signal survive.
--   pending / in_progress / done / cancelled rows go through unchanged;
--   no row gets re-tagged as paused.

PRAGMA foreign_keys=OFF;

CREATE TABLE tasks_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,                       -- Telegram user id
  title             TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','in_progress','paused','done','cancelled')),
  priority          INTEGER NOT NULL DEFAULT 3,              -- 1 highest, 5 lowest
  context_note      TEXT,                                    -- why it matters / when relevant
  scheduled_for     TEXT,                                    -- ISO datetime OR loose text ("morning")
  is_recurring      INTEGER NOT NULL DEFAULT 0,
  recurrence_rule   TEXT,                                    -- JSON: {"freq":"daily"} or {"freq":"weekly","days":["mon","wed"]}
  last_completed_at TEXT,
  cancel_reason     TEXT,
  last_nudged_at    TEXT,                                    -- ISO ts from nudger; null before first nudge
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO tasks_new
  (id, user_id, title, status, priority, context_note, scheduled_for,
   is_recurring, recurrence_rule, last_completed_at, cancel_reason,
   last_nudged_at, created_at, updated_at)
SELECT
  id, user_id, title, status, priority, context_note, scheduled_for,
  is_recurring, recurrence_rule, last_completed_at, cancel_reason,
  last_nudged_at, created_at, updated_at
  FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

-- Indexes from 0001_initial.sql and 0004_nudge_and_direct_commands.sql.
CREATE INDEX IF NOT EXISTS idx_tasks_user_status
  ON tasks (user_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_user_recurring
  ON tasks (user_id, is_recurring);

CREATE INDEX IF NOT EXISTS idx_tasks_user_last_nudged
  ON tasks (user_id, last_nudged_at);

PRAGMA foreign_keys=ON;
