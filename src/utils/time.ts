// Time helpers. We keep timezone handling deliberately simple: pass
// an IANA zone name (e.g. "Africa/Nairobi") and use Intl.DateTimeFormat
// to derive the local calendar date / weekday. Cloudflare Workers ship
// the full ICU dataset so this works out of the box.

export function nowIso(): string {
  return new Date().toISOString();
}

export function localDateParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    weekday: parts.weekday.toLowerCase().slice(0, 3),
  };
}

export function localDateString(date: Date, timezone: string): string {
  const { year, month, day } = localDateParts(date, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function localWeekday(date: Date, timezone: string): string {
  return localDateParts(date, timezone).weekday;
}

/** Rough "time of day" bucket for the system prompt. */
export function localTimeOfDay(date: Date, timezone: string): string {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  const hour = parseInt(hourStr, 10);
  if (hour < 5) return 'late night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}
