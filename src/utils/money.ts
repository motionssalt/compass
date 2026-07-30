// Money helpers. All storage is in integer minor units (cents) to
// avoid floating-point drift; conversion to/from decimal strings
// happens here at the runtime edges.
//
// We intentionally keep this dumb: two decimals, no currency-aware
// exponent lookup, no locale-specific separators. The user reports
// amounts in whatever currency they've chosen and we round-trip
// exactly what they said.

/**
 * Parse a user-supplied amount ("$1,234.50", "1234.5", "  20 ") into
 * integer cents. Returns null if the input is not a recognisable
 * number. Accepts a leading currency symbol and comma thousands
 * separators.
 */
export function parseAmountToCents(input: string | number | undefined | null): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  const cleaned = input.trim().replace(/[,\s$€£₹]/g, '');
  if (!cleaned) return null;
  // Allow optional leading minus and a single decimal point.
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/** Format integer cents as a plain decimal string with two places. */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Format cents with currency: "USD 1234.50". */
export function formatMoney(cents: number, currency: string): string {
  return `${currency} ${formatCents(cents)}`;
}
