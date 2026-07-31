// Inline-keyboard builders and callback_data encoding for the /menu
// button system.
//
// callback_data encoding
// ----------------------
// Telegram caps `callback_data` at 64 bytes. We use a compact
// colon-separated scheme so a decoder never needs to guess:
//
//   <v>:<domain>:<action>[:<arg1>[:<arg2>...]]
//
// where:
//   v       = protocol version (currently "1"). Lets us evolve
//             encoding without confusing older cached buttons.
//   domain  = one of "root", "tasks", "fin", "set", "flow", "nav"
//   action  = short verb tag ("today", "add", "prio", "pick", ...)
//   argN    = short opaque args (task ids, letter grades, minutes,
//             a timezone slot index, a currency code, etc.)
//
// Free-form user text (arbitrary task titles, IANA identifiers, cash
// amounts) is NEVER embedded in callback_data. Those come through a
// follow-up free-text message, driven by pending_flows state.

import type { InlineKeyboardButton, InlineKeyboardMarkup } from '../types/telegram';
import { PRIORITY_LETTERS } from '../utils/priority';

export const CB_VERSION = '1';

// ---------------------------------------------------------------
// callback_data helpers
// ---------------------------------------------------------------

export function cb(domain: string, action: string, ...args: string[]): string {
  const parts = [CB_VERSION, domain, action, ...args];
  const s = parts.join(':');
  // Cheap safety net — we never emit anything close to 64B for our
  // fixed vocab, but a bug that pushes past it would silently fail
  // in Telegram, so surface it loudly during development.
  if (s.length > 64) {
    throw new Error(`callback_data too long (${s.length}B): ${s}`);
  }
  return s;
}

export interface DecodedCb {
  version: string;
  domain: string;
  action: string;
  args: string[];
}

export function decodeCb(data: string): DecodedCb | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length < 3) return null;
  const [version, domain, action, ...args] = parts;
  if (!version || !domain || !action) return null;
  return { version, domain, action, args };
}

// ---------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------

/** Assemble a keyboard from a 2D array of buttons. Empty rows dropped. */
export function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows.filter((r) => r.length > 0) };
}

function btn(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: data };
}

// ---------------------------------------------------------------
// Root menu
// ---------------------------------------------------------------

export function rootMenuKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn('📋 Tasks',    cb('root', 'tasks'))],
    [btn('💰 Finance',  cb('root', 'fin'))],
    [btn('⚙️ Settings', cb('root', 'set'))],
    [btn('✖️ Close',    cb('nav',  'close'))],
  ]);
}

export const ROOT_MENU_TEXT =
  `What do you want to do?\n\nTap a category to see its actions. Nothing here needs typing unless you want to add or edit something specific.`;

// ---------------------------------------------------------------
// Tasks submenu
// ---------------------------------------------------------------

export function tasksMenuKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn('📅 Today',         cb('tasks', 'today'))],
    [btn('🗂️ All tasks',    cb('tasks', 'all'))],
    [btn('🔀 Flexible (by priority)', cb('tasks', 'flex'))],
    [btn('➕ Add task',      cb('tasks', 'add'))],
    [btn('✏️ Edit task',     cb('tasks', 'editpick'))],
    // Direct status changes — same picker under the hood as Edit /
    // Delete, purpose token routes to the shared 'tpick' handler.
    [
      btn('▶️ Start',  cb('tasks', 'startpick')),
      btn('✅ Finish', cb('tasks', 'finishpick')),
    ],
    [
      btn('⏸️ Pause',  cb('tasks', 'pausepick')),
      btn('▶️ Resume', cb('tasks', 'resumepick')),
    ],
    [btn('🗑️ Delete task',   cb('tasks', 'delpick'))],
    [btn('« Back',           cb('nav',   'root'))],
  ]);
}

export const TASKS_MENU_TEXT = `Tasks — pick one:`;

// ---------------------------------------------------------------
// Finance submenu
// ---------------------------------------------------------------

export function financeMenuKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn('💵 View balance',  cb('fin', 'bal'))],
    [btn('📒 View debts',    cb('fin', 'debts'))],
    [btn('➕ Add to balance', cb('fin', 'add'))],
    [btn('✍️ Set balance',    cb('fin', 'set'))],
    [btn('➡️ Move to set-aside',   cb('fin', 'aside_to'))],
    [btn('⬅️ Take from set-aside', cb('fin', 'aside_from'))],
    [btn('💱 Default currency',    cb('fin', 'curr'))],
    [btn('« Back',           cb('nav', 'root'))],
  ]);
}

export const FINANCE_MENU_TEXT = `Finance — pick one:`;

// ---------------------------------------------------------------
// Settings submenu
// ---------------------------------------------------------------

export function settingsMenuKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [btn('🕒 Timezone',     cb('set', 'tz'))],
    [btn('⚠️ Reset all data', cb('set', 'reset'))],
    [btn('« Back',          cb('nav', 'root'))],
  ]);
}

export const SETTINGS_MENU_TEXT = `Settings — pick one:`;

// ---------------------------------------------------------------
// Priority-picker (used by add-task and edit-task flows)
// ---------------------------------------------------------------
//
// The full 15-grade letter scale is a lot for a button grid. We
// surface the 5 "band" letters (A..E) directly and put the +/-
// modifiers on a compact second row via a nested "fine-tune" step.
// For the initial pick we offer the plain grade, then a "fine tune
// +/-" pass. That keeps the visible surface small without hiding
// the full scale.

export function priorityBandKeyboard(purpose: 'add' | 'edit'): InlineKeyboardMarkup {
  // Two rows: bands, then a "skip / cancel" row.
  const bands = ['A', 'B', 'C', 'D', 'E'];
  const row = bands.map((b) => btn(b, cb('flow', 'prio', purpose, b)));
  return keyboard([
    row,
    [btn('Skip (use C)', cb('flow', 'prio', purpose, 'skip'))],
    [btn('✖️ Cancel',     cb('flow', 'cancel'))],
  ]);
}

/**
 * Second-stage priority picker — offers the band you chose plus its
 * +/- variants (e.g. A+, A, A-). Skipping here keeps the plain band.
 */
export function priorityFineKeyboard(
  purpose: 'add' | 'edit', band: string,
): InlineKeyboardMarkup {
  const plus  = `${band}+`;
  const plain = band;
  const minus = `${band}-`;
  const row = [
    btn(plus,  cb('flow', 'priof', purpose, plus)),
    btn(plain, cb('flow', 'priof', purpose, plain)),
    btn(minus, cb('flow', 'priof', purpose, minus)),
  ].filter((b) => (PRIORITY_LETTERS as readonly string[]).includes(
    b.callback_data!.split(':').pop()!,
  ));
  return keyboard([
    row,
    [btn('« Back', cb('flow', 'priob', purpose))],
    [btn('✖️ Cancel', cb('flow', 'cancel'))],
  ]);
}

// ---------------------------------------------------------------
// Duration picker (for add-task and edit-task)
// ---------------------------------------------------------------

/**
 * Rough duration buckets covering "quick task" to "half day". Values
 * chosen to line up with the nudge scorer's granularity — anything
 * more precise the user can just type via /edittask.
 */
export const DURATION_MINUTES = [5, 10, 15, 30, 45, 60, 90, 120, 240] as const;

export function durationKeyboard(purpose: 'add' | 'edit'): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  // Three per row, up to 9 values.
  for (let i = 0; i < DURATION_MINUTES.length; i += 3) {
    rows.push(
      DURATION_MINUTES.slice(i, i + 3).map((m) =>
        btn(labelForMinutes(m), cb('flow', 'dur', purpose, String(m))),
      ),
    );
  }
  rows.push([btn('Skip', cb('flow', 'dur', purpose, 'skip'))]);
  rows.push([btn('✖️ Cancel', cb('flow', 'cancel'))]);
  return keyboard(rows);
}

function labelForMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

// ---------------------------------------------------------------
// Confirm keyboard (final "create it?" gate on add-task)
// ---------------------------------------------------------------

export function confirmCreateKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [
      btn('✅ Create', cb('flow', 'confirm', 'add')),
      btn('✖️ Cancel', cb('flow', 'cancel')),
    ],
  ]);
}

// ---------------------------------------------------------------
// Task-picker keyboard (edit-task step 1)
// ---------------------------------------------------------------
//
// Up to ~12 open tasks by (priority, created_at). callback_data
// carries only the task id — the caller's flow state tracks purpose.

export function taskPickerKeyboard(
  tasks: { id: number; title: string; priority: number }[],
  purpose: 'edit' | 'delete' | 'start' | 'finish' | 'pause' | 'resume',
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  for (const t of tasks.slice(0, 12)) {
    const shortTitle = t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title;
    rows.push([btn(`#${t.id} ${shortTitle}`, cb('flow', 'tpick', purpose, String(t.id)))]);
  }
  rows.push([btn('✖️ Cancel', cb('flow', 'cancel'))]);
  return keyboard(rows);
}

/** Which field of the picked task to edit. */
export function editFieldKeyboard(taskId: number): InlineKeyboardMarkup {
  return keyboard([
    [btn('Title',    cb('flow', 'efield', String(taskId), 'title'))],
    [btn('Priority', cb('flow', 'efield', String(taskId), 'prio'))],
    [btn('Duration', cb('flow', 'efield', String(taskId), 'dur'))],
    [btn('When',     cb('flow', 'efield', String(taskId), 'when'))],
    [btn('Status',   cb('flow', 'efield', String(taskId), 'status'))],
    [btn('✖️ Cancel', cb('flow', 'cancel'))],
  ]);
}

/** Status buttons for the edit-task "Status" field. */
export function statusPickerKeyboard(taskId: number): InlineKeyboardMarkup {
  return keyboard([
    [btn('Pending',     cb('flow', 'estatus', String(taskId), 'pending'))],
    [btn('In progress', cb('flow', 'estatus', String(taskId), 'in_progress'))],
    [btn('Paused',      cb('flow', 'estatus', String(taskId), 'paused'))],
    [btn('Done',        cb('flow', 'estatus', String(taskId), 'done'))],
    [btn('Cancelled',   cb('flow', 'estatus', String(taskId), 'cancelled'))],
    [btn('✖️ Cancel', cb('flow', 'cancel'))],
  ]);
}

// ---------------------------------------------------------------
// Timezone picker (Settings → Timezone)
// ---------------------------------------------------------------
//
// callback_data can't carry a whole IANA string within 64 bytes
// reliably (some like "America/Argentina/Buenos_Aires" push past
// budget when combined with our prefix), so we ship a fixed slot
// list and encode a small integer index.

export interface TzSlot { label: string; iana: string }

export const TZ_SLOTS: readonly TzSlot[] = [
  { label: '🇺🇸 New York',   iana: 'America/New_York' },
  { label: '🇺🇸 Los Angeles', iana: 'America/Los_Angeles' },
  { label: '🇺🇸 Chicago',    iana: 'America/Chicago' },
  { label: '🇨🇦 Toronto',    iana: 'America/Toronto' },
  { label: '🇬🇧 London',     iana: 'Europe/London' },
  { label: '🇮🇪 Dublin',     iana: 'Europe/Dublin' },
  { label: '🇩🇪 Berlin',     iana: 'Europe/Berlin' },
  { label: '🇫🇷 Paris',      iana: 'Europe/Paris' },
  { label: '🇳🇬 Lagos',      iana: 'Africa/Lagos' },
  { label: '🇰🇪 Nairobi',    iana: 'Africa/Nairobi' },
  { label: '🇿🇦 Johannesburg', iana: 'Africa/Johannesburg' },
  { label: '🇪🇬 Cairo',      iana: 'Africa/Cairo' },
  { label: '🇮🇳 Mumbai',     iana: 'Asia/Kolkata' },
  { label: '🇦🇪 Dubai',      iana: 'Asia/Dubai' },
  { label: '🇸🇬 Singapore',  iana: 'Asia/Singapore' },
  { label: '🇯🇵 Tokyo',      iana: 'Asia/Tokyo' },
  { label: '🇭🇰 Hong Kong',  iana: 'Asia/Hong_Kong' },
  { label: '🇦🇺 Sydney',     iana: 'Australia/Sydney' },
  { label: '🇧🇷 São Paulo',  iana: 'America/Sao_Paulo' },
  { label: '🌐 UTC',         iana: 'UTC' },
];

export function timezoneKeyboard(): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  // Two per row for readability.
  for (let i = 0; i < TZ_SLOTS.length; i += 2) {
    const pair = TZ_SLOTS.slice(i, i + 2).map((slot, j) =>
      btn(slot.label, cb('set', 'tzpick', String(i + j))),
    );
    rows.push(pair);
  }
  rows.push([btn('✍️ Other (type IANA)', cb('set', 'tzother'))]);
  rows.push([btn('« Back', cb('nav', 'set'))]);
  return keyboard(rows);
}

// ---------------------------------------------------------------
// Default currency picker (Finance → Default currency)
// ---------------------------------------------------------------

export const CURRENCY_SLOTS: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY',
  'CAD', 'AUD', 'CHF', 'CNY',
  'INR', 'NGN', 'KES', 'ZAR',
  'BRL', 'MXN', 'AED', 'SGD',
];

export function currencyKeyboard(): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < CURRENCY_SLOTS.length; i += 4) {
    rows.push(
      CURRENCY_SLOTS.slice(i, i + 4).map((c) => btn(c, cb('fin', 'currpick', c))),
    );
  }
  rows.push([btn('✍️ Other (type code)', cb('fin', 'currother'))]);
  rows.push([btn('« Back', cb('nav', 'fin'))]);
  return keyboard(rows);
}

// ---------------------------------------------------------------
// Confirm-large-overwrite keyboard (Finance → Set balance)
// ---------------------------------------------------------------
//
// Called only when the user's typed amount would trip the same
// large-overwrite gate the AI-side already respects. Reuses the
// existing pending_confirmations token — the button just carries
// the token straight through.

export function overwriteConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return keyboard([
    [
      btn('✅ Confirm overwrite', cb('fin', 'setok', token)),
      btn('✖️ Cancel',            cb('flow', 'cancel')),
    ],
  ]);
}

// ---------------------------------------------------------------
// Confirm-delete-task keyboard (Tasks → Delete task)
// ---------------------------------------------------------------
//
// Second-stage gate for the button-driven /deletetask flow. The
// callback carries a pending_confirmations token — the same shape
// used for overwrite_balance and delete_debt — so the confirm side
// can't be replayed and can't outlive the 15-minute TTL.

export function deleteTaskConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return keyboard([
    [
      btn('✅ Confirm delete', cb('tasks', 'delok', token)),
      btn('✖️ Cancel',        cb('flow', 'cancel')),
    ],
  ]);
}

// ---------------------------------------------------------------
// Confirm-reset-all keyboard (Settings → Reset all data)
// ---------------------------------------------------------------
//
// Same pending_confirmations token pattern. The action is by far
// the most destructive one the bot exposes — keep the two-button
// layout so "Confirm" is never a slip-of-the-thumb from the
// previous screen.

export function resetConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return keyboard([
    [
      btn('✅ Yes, wipe everything', cb('set', 'resetok', token)),
      btn('✖️ Cancel',              cb('flow', 'cancel')),
    ],
  ]);
}
