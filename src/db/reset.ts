// Global per-user data reset.
//
// Wipes ALL rows belonging to a single user across every user-scoped
// table this bot writes to, EXCEPT api_keys (that's the user's own
// Gemini key material and is deliberately preserved so they don't
// have to re-enter it after a reset).
//
// Scope is strictly `WHERE user_id = ?1` on every table \u2014 no other
// user's data is ever touched.
//
// This is destructive and irrecoverable. Callers MUST route through
// the existing pending_confirmations flow (see src/db/confirmations.ts)
// so the user has explicitly said "yes, wipe it" via a fresh, short-
// lived token, matching the pattern used for delete_debt and large
// balance overwrites.
//
// Tables reset (all `user_id`-scoped):
//   - tasks
//   - debts
//   - user_balance                (main balance + set-aside bucket)
//   - conversation_log            (chat history)
//   - user_nudge_state            (last-nudged / free-window state)
//   - pending_confirmations       (any other stale tokens for this user)
//   - pending_flows               (any half-finished button flow)
//   - users                       (default_currency + timezone settings)
//
// NOT touched:
//   - api_keys                    (user's own Gemini key)
//   - any other user's rows on any table

export interface ResetCounts {
  tasks: number;
  debts: number;
  user_balance: number;
  conversation_log: number;
  user_nudge_state: number;
  pending_confirmations: number;
  pending_flows: number;
  users: number;
}

/**
 * Delete every row belonging to `userId` across the user-scoped
 * tables listed above. Returns a per-table count of rows removed so
 * the caller can echo a receipt back to the user.
 *
 * Uses D1's batch() so the deletes go through in a single round-trip
 * and either all succeed or none do \u2014 no half-wiped state.
 */
export async function resetUserData(
  db: D1Database, userId: number,
): Promise<ResetCounts> {
  const stmts = [
    db.prepare(`DELETE FROM tasks WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM debts WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM user_balance WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM conversation_log WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM user_nudge_state WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM pending_confirmations WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM pending_flows WHERE user_id = ?1`).bind(userId),
    // users row LAST \u2014 wipes stored timezone + default_currency.
    // upsertUser (called on the very next inbound message) will
    // re-materialise a minimal row with no preferences, so the user
    // is genuinely back to a fresh-start state.
    db.prepare(`DELETE FROM users WHERE user_id = ?1`).bind(userId),
  ];
  const results = await db.batch(stmts);
  const c = (i: number) => (results[i]?.meta?.changes ?? 0);
  return {
    tasks:                 c(0),
    debts:                 c(1),
    user_balance:          c(2),
    conversation_log:      c(3),
    user_nudge_state:      c(4),
    pending_confirmations: c(5),
    pending_flows:         c(6),
    users:                 c(7),
  };
}
