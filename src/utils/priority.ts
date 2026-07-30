// Letter-grade priority scale, used by BOTH tasks (`priority`) and
// debts (`urgency`). One source of truth for the scale — every read,
// write, sort, and display path routes through this module.
//
// Storage stays as a small INTEGER in D1 so existing `ORDER BY
// priority ASC` / `ORDER BY urgency ASC` clauses continue to mean
// "most important first" without any application-side re-sort:
//
//   1  = A+   (must happen now)
//   2  = A
//   3  = A-
//   4  = B+
//   5  = B
//   6  = B-
//   7  = C+
//   8  = C   (normal — the default)
//   9  = C-
//   10 = D+
//   11 = D
//   12 = D-
//   13 = E+
//   14 = E
//   15 = E-  (someday / drop-if-needed)
//
// The letter grade is the ONLY representation the AI and the user
// ever see. Integers are an internal storage detail.

export type PriorityLetter =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D+' | 'D' | 'D-'
  | 'E+' | 'E' | 'E-';

export const PRIORITY_LETTERS: readonly PriorityLetter[] = [
  'A+', 'A', 'A-',
  'B+', 'B', 'B-',
  'C+', 'C', 'C-',
  'D+', 'D', 'D-',
  'E+', 'E', 'E-',
];

/** The neutral default when the caller supplies nothing. */
export const DEFAULT_PRIORITY_LETTER: PriorityLetter = 'C';
export const DEFAULT_PRIORITY_INT = 8;

export const MIN_PRIORITY_INT = 1;   // A+
export const MAX_PRIORITY_INT = 15;  // E-

/**
 * Convert a stored integer (1..15) to its letter grade. Values
 * outside the range are clamped so we never crash on a stray value
 * left over from a partial backfill or a bad hand-edit.
 */
export function priorityIntToLetter(n: number | null | undefined): PriorityLetter {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return DEFAULT_PRIORITY_LETTER;
  }
  const clamped = Math.max(MIN_PRIORITY_INT, Math.min(MAX_PRIORITY_INT, Math.round(n)));
  return PRIORITY_LETTERS[clamped - 1];
}

/**
 * Convert a letter grade to its stored integer. Accepts loose input
 * (case-insensitive, whitespace tolerated) so tool arguments coming
 * from the model don't have to be perfectly normalised.
 *
 * Returns null when the input isn't a recognisable letter grade so
 * callers can distinguish "not provided" from "provided but garbled".
 */
export function priorityLetterToInt(letter: string | null | undefined): number | null {
  if (letter === null || letter === undefined) return null;
  const normalised = String(letter).trim().toUpperCase().replace(/\s+/g, '');
  if (!normalised) return null;

  // Accept "A", "A+", "A-"; also tolerate a bare letter alone (treat
  // as the plain grade, no +/-).
  const m = /^([A-E])([+-]?)$/.exec(normalised);
  if (!m) return null;
  const band = m[1];
  const mod = m[2];

  const bandBase: Record<string, number> = { A: 1, B: 4, C: 7, D: 10, E: 13 };
  const base = bandBase[band];
  if (base === undefined) return null;

  if (mod === '+') return base;       // A+ / B+ / ...
  if (mod === '-') return base + 2;   // A- / B- / ...
  return base + 1;                    // plain A / B / ...
}

/**
 * Normalise any priority-ish input (letter grade OR an existing
 * integer) to the stored integer, falling back to the default when
 * nothing usable was supplied. Used in every INSERT/UPDATE path.
 */
export function normalisePriorityToInt(
  input: string | number | null | undefined,
): number {
  if (input === null || input === undefined) return DEFAULT_PRIORITY_INT;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return DEFAULT_PRIORITY_INT;
    return Math.max(MIN_PRIORITY_INT, Math.min(MAX_PRIORITY_INT, Math.round(input)));
  }
  const asLetter = priorityLetterToInt(input);
  if (asLetter !== null) return asLetter;
  // As a last resort, allow a numeric string ("8", "2.5").
  const asNum = Number(input);
  if (Number.isFinite(asNum)) {
    return Math.max(MIN_PRIORITY_INT, Math.min(MAX_PRIORITY_INT, Math.round(asNum)));
  }
  return DEFAULT_PRIORITY_INT;
}

/**
 * Comparator over stored integers: lower = more important (A+ first,
 * E- last), matching the SQL `ORDER BY ... ASC` convention already
 * used in tasks.ts / debts.ts.
 */
export function comparePriorityInt(a: number, b: number): number {
  return a - b;
}

/** Same comparator, but over letter-grade strings. */
export function comparePriorityLetter(a: PriorityLetter, b: PriorityLetter): number {
  return (priorityLetterToInt(a) ?? DEFAULT_PRIORITY_INT)
       - (priorityLetterToInt(b) ?? DEFAULT_PRIORITY_INT);
}

/**
 * True when `letter` is a recognised grade. Handy for validating
 * tool arguments before writing them.
 */
export function isValidPriorityLetter(letter: string): boolean {
  return priorityLetterToInt(letter) !== null;
}
