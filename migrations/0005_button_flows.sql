-- Motionsalt Compass — inline-keyboard button-flow state.
--
-- Same conventions as prior migrations:
--   * ISO-8601 UTC TEXT timestamps
--   * booleans as 0/1 INTEGERs
--   * IDs are AUTOINCREMENT INTEGER
--
-- Nothing here is destructive — the new table is additive and does
-- NOT touch pending_confirmations (which stays exactly as-is for the
-- existing delete_debt / overwrite_balance confirm-before-execute
-- flows). This new table is a separate concern: it tracks multi-
-- step INLINE-KEYBOARD progress (e.g. "user tapped Add Task → now
-- waiting for a free-text title reply") which has a different
-- shape from the single-use confirmation-token model.
--
-- Why a new table (rather than extending pending_confirmations):
--   * pending_confirmations is single-use and consumed on read; a
--     button flow spans several turns and mutates its own state.
--   * The confirmation table is scoped by opaque token; a button
--     flow is scoped by (user_id) with at most one active flow per
--     user at a time. Different key shape.
--   * Keeping them separate means the existing confirmation flow's
--     invariants (single-use, action-locked) don't have to be
--     softened just to shoehorn button-flow state in.
--
-- One row per user max; a new /menu press or a completed/cancelled
-- flow deletes the row.

CREATE TABLE IF NOT EXISTS pending_flows (
  user_id      INTEGER PRIMARY KEY,        -- Telegram user id; at most one active flow per user
  flow         TEXT    NOT NULL,           -- e.g. 'add_task', 'edit_task', 'tz_other', 'currency_other', 'balance_add', 'balance_set', 'setaside_to', 'setaside_from'
  step         TEXT    NOT NULL,           -- flow-specific step identifier (e.g. 'await_title', 'await_priority', 'await_duration')
  state        TEXT    NOT NULL DEFAULT '{}', -- JSON blob of accumulated fields for the flow
  chat_id      INTEGER,                    -- chat where the flow originated (usually == user_id for private)
  prompt_msg_id INTEGER,                   -- message_id of the prompt we most recently sent, for optional edit-in-place
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT    NOT NULL            -- ISO-8601 UTC; runtime treats older rows as absent
);

CREATE INDEX IF NOT EXISTS idx_pending_flows_expires
  ON pending_flows (expires_at);
