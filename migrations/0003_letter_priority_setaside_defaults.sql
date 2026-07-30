-- Motionsalt Compass — letter-grade priority, task time estimates,
-- recurring debts, set-aside/undecided money bucket, and per-user
-- default currency.
--
-- Same conventions as prior migrations:
--   * ISO-8601 UTC TEXT timestamps
--   * booleans as 0/1 INTEGERs
--   * IDs are AUTOINCREMENT INTEGER
--
-- Priority / urgency representation change
-- ----------------------------------------
-- Previously `tasks.priority` and `debts.urgency` were 1..5 INTEGERs.
-- We're switching to a letter-grade scale (A+, A, A-, B+, ... E-) with
-- 15 gradations. To keep SQL `ORDER BY priority ASC` still meaning
-- "most important first" (as the existing queries assume), we keep
-- INTEGER storage but widen the range to 1..15 where:
--
--   1 = A+   4 = B+   7 = C+   10 = D+   13 = E+
--   2 = A    5 = B    8 = C    11 = D    14 = E
--   3 = A-   6 = B-   9 = C-   12 = D-   15 = E-
--
-- Backfill maps the old 1..5 scale into the middle letter of each
-- band (A / B / C / D / E — the plain letter, not the +/-), which
-- reads as the most sensible equivalent of a bare 1..5.
--
--   old 1 -> new 2 (A)
--   old 2 -> new 5 (B)
--   old 3 -> new 8 (C)
--   old 4 -> new 11 (D)
--   old 5 -> new 14 (E)
--
-- The single source of truth for the letter <-> integer mapping is
-- src/utils/priority.ts; SQL only ever sees the integer.
--
-- New CHECK constraints would require rebuilding the tables in
-- SQLite, which is heavier than we need here — the runtime clamps
-- to the valid range via the shared helper before any INSERT/UPDATE.

-- ---------------------------------------------------------------
-- tasks: widen priority range + new time_estimate_minutes column
-- ---------------------------------------------------------------

-- Backfill existing 1..5 rows to their letter-grade equivalents
-- BEFORE any new inserts can happen.
UPDATE tasks
   SET priority = CASE priority
                    WHEN 1 THEN 2
                    WHEN 2 THEN 5
                    WHEN 3 THEN 8
                    WHEN 4 THEN 11
                    WHEN 5 THEN 14
                    ELSE 8
                  END
 WHERE priority BETWEEN 1 AND 5;

ALTER TABLE tasks ADD COLUMN time_estimate_minutes INTEGER;

-- ---------------------------------------------------------------
-- debts: same priority remap + recurring-debt columns
-- ---------------------------------------------------------------

UPDATE debts
   SET urgency = CASE urgency
                   WHEN 1 THEN 2
                   WHEN 2 THEN 5
                   WHEN 3 THEN 8
                   WHEN 4 THEN 11
                   WHEN 5 THEN 14
                   ELSE 8
                 END
 WHERE urgency BETWEEN 1 AND 5;

-- Recurring debts (rent, subscriptions, monthly obligations). Same
-- shape as tasks.is_recurring / tasks.recurrence_rule so the runtime
-- can reuse the same helpers.
ALTER TABLE debts ADD COLUMN is_recurring     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE debts ADD COLUMN recurrence_rule  TEXT;                    -- JSON, same shape as tasks
ALTER TABLE debts ADD COLUMN last_reopened_at TEXT;                    -- tracks the last cron reopen

CREATE INDEX IF NOT EXISTS idx_debts_user_recurring
  ON debts (user_id, is_recurring);

-- ---------------------------------------------------------------
-- user_balance: set-aside / "undecided" bucket
-- ---------------------------------------------------------------
--
-- A single per-user column, mirroring the existing single-row-per-user
-- shape of user_balance. Same currency as the main balance — the
-- bucket is always denominated in whatever currency the main balance
-- is in, so we don't need a separate currency column.

ALTER TABLE user_balance ADD COLUMN set_aside_cents INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------
-- users: per-user default currency
-- ---------------------------------------------------------------
--
-- Nullable so the runtime can distinguish "user has never chosen"
-- (fall back to 'USD') from "user explicitly picked USD". Set via
-- the new set_default_currency tool.

ALTER TABLE users ADD COLUMN default_currency TEXT;
