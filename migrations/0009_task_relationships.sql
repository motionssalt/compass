-- Motionsalt Compass — task relationships (dependencies + parent/subtask).
--
-- Same conventions as prior migrations:
--   * ISO-8601 UTC TEXT timestamps
--   * booleans as 0/1 INTEGERs
--   * IDs are AUTOINCREMENT INTEGER
--   * additive columns with sensible NULL defaults so unmigrated code
--     paths and unmigrated rows keep working unchanged
--
-- Background. Two separate but adjacent relationships between tasks:
--
--   1. depends_on_task_id — a soft, INFORMATIONAL "Task B can't
--      reasonably start until Task A is done" link. Nothing in the
--      write path blocks on it: a user CAN mark Task B done while
--      Task A is still open, and the AI CAN start it if the user
--      asks. It's carried purely so the AI's nudger / recommender
--      can down-rank suggestions whose dependency is still open, and
--      so task listings can surface the link.
--
--   2. parent_task_id — a HARD, blocking parent/subtask structure.
--      A parent task's completion is literally defined by its
--      subtasks: the parent CANNOT transition to status='done' while
--      any subtask is still open (pending / in_progress / paused).
--      The enforcement lives in src/db/tasks.updateTaskStatus so
--      every write path (AI tool, direct slash command, button flow)
--      inherits the gate from the same place.
--
-- Deliberately NOT the same column. Reusing depends_on for parenthood
-- would fold two very different semantics into one field: "I'd
-- rather not start B before A" (soft) versus "A cannot be finished
-- while any of its parts remain" (hard, structural). Keeping them
-- separate means the block gate has an unambiguous target and the
-- soft link doesn't accidentally propagate blocking behaviour.
--
-- Both columns are nullable INTEGER referring to tasks(id) in the
-- SAME row's user (that scoping is enforced at write-time in
-- src/db/tasks.ts, not by a DB-level constraint — cross-user linking
-- would be a bug the app catches sooner than the schema could).
--
-- ON DELETE handling. The existing deleteTask helper hard-deletes a
-- single row; we don't want a hard-delete of one task to leave stale
-- integer FKs on siblings / children pointing at nothing. SQLite's
-- REFERENCES clause with ON DELETE SET NULL takes care of that
-- cleanly IF the pragma is on (Cloudflare D1 defaults foreign_keys
-- to ON per-statement). The tests here are:
--   * delete a parent -> children's parent_task_id resets to NULL
--     (subtasks become top-level; they are NOT recursively deleted).
--   * delete a dependency-target -> dependent tasks lose the pointer
--     but stay intact.
--
-- Indexes. Two narrow, partial-where-possible indexes so the "does
-- this parent have any open subtasks?" gate query in
-- updateTaskStatus is O(index-lookup) rather than a per-user scan,
-- and so the systemPrompt's per-task decoration ("depends_on=#N",
-- "subtask_of=#N" pointers) can be resolved cheaply.

-- ---------------------------------------------------------------
-- tasks.depends_on_task_id
-- ---------------------------------------------------------------
-- Soft, informational dependency pointer. Nothing in the DB layer
-- treats this as blocking; the AI's nudger and the systemPrompt
-- consult it to shape recommendations.
ALTER TABLE tasks ADD COLUMN depends_on_task_id INTEGER
  REFERENCES tasks(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------
-- tasks.parent_task_id
-- ---------------------------------------------------------------
-- Hard, blocking parent/subtask pointer. The gate lives in
-- src/db/tasks.updateTaskStatus: a parent row cannot transition to
-- status='done' while any child row is still open (pending /
-- in_progress / paused). "done" and "cancelled" subtasks are
-- considered resolved for the purpose of that gate.
ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER
  REFERENCES tasks(id) ON DELETE SET NULL;

-- Indexes.
--
-- The parent gate query — "does row #P have any open child?" —
-- filters on (user_id, parent_task_id, status), so a
-- (user_id, parent_task_id) index carries most of the work; the
-- status filter is a cheap final narrowing on the tiny per-parent
-- child set. Partial WHERE keeps the index compact — the vast
-- majority of rows have parent_task_id IS NULL.
CREATE INDEX IF NOT EXISTS idx_tasks_user_parent
  ON tasks (user_id, parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- The dependency lookup is symmetric enough (both "what does X
-- depend on" and "what depends on X" are useful) to warrant an
-- index, again partial to keep it lean.
CREATE INDEX IF NOT EXISTS idx_tasks_user_depends_on
  ON tasks (user_id, depends_on_task_id)
  WHERE depends_on_task_id IS NOT NULL;
