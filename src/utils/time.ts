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

/** Full weekday name ("Friday") for prose the user actually reads. */
export function localWeekdayLong(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(date);
}

/**
 * Local wall clock as 24-hour "HH:MM".
 *
 * Note the `hourCycle: 'h23'`: with plain `hour12: false` some ICU
 * builds render midnight as "24:00", which would make the AI describe
 * 00:15 as "24:15" and push a date boundary the wrong way.
 */
export function localClockString(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/**
 * The zone's UTC offset, in minutes east of UTC, at this instant.
 *
 * Derived by asking Intl for the same instant's wall-clock fields in
 * the target zone and diffing against the real epoch — which means DST
 * and half-hour/quarter-hour zones (Asia/Kolkata, Australia/Adelaide,
 * Pacific/Marquesas) come out right without a tz database of our own.
 */
export function utcOffsetMinutes(date: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = fmt.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    parseInt(p.hour, 10),
    parseInt(p.minute, 10),
    parseInt(p.second, 10),
  );
  // Round to the minute: the epoch carries ms the formatted parts drop.
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Render an offset in minutes as an ISO-style "+03:00" / "-04:30". */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** Rough "time of day" bucket for the system prompt. */
export function localTimeOfDay(date: Date, timezone: string): string {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const hour = parseInt(hourStr, 10);
  if (hour < 5) return 'late night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

/**
 * One complete clock reading for a given instant in a given zone.
 *
 * This is the shape handed to the AI every turn (see
 * ai/systemPrompt.ts) and printed by /time. It exists so that the
 * date, the weekday, the wall clock and the offset are all derived
 * from ONE `Date` — computing them separately let them disagree
 * across a midnight boundary, which is exactly the kind of drift that
 * made the model second-guess itself and start guessing.
 */
export interface LocalNow {
  /** Local calendar date, "2026-07-31". */
  date: string;
  /** Short weekday, "fri" — matches localWeekday()'s existing shape. */
  weekday: string;
  /** Full weekday for prose, "Friday". */
  weekdayLong: string;
  /** Local wall clock, 24-hour "22:37". */
  clock: string;
  /** Bucket from localTimeOfDay(), e.g. "evening". */
  partOfDay: string;
  /** Offset east of UTC in minutes, e.g. 180. */
  offsetMinutes: number;
  /** Offset rendered ISO-style, e.g. "+03:00". */
  offset: string;
  /** Full local timestamp with offset, "2026-07-31T22:37+03:00". */
  localIso: string;
  /** The same instant in UTC, for unambiguous cross-checking. */
  utcIso: string;
}

export function localNow(date: Date, timezone: string): LocalNow {
  const dateStr = localDateString(date, timezone);
  const clock = localClockString(date, timezone);
  const offsetMinutes = utcOffsetMinutes(date, timezone);
  const offset = formatUtcOffset(offsetMinutes);
  return {
    date: dateStr,
    weekday: localWeekday(date, timezone),
    weekdayLong: localWeekdayLong(date, timezone),
    clock,
    partOfDay: localTimeOfDay(date, timezone),
    offsetMinutes,
    offset,
    localIso: `${dateStr}T${clock}${offset}`,
    utcIso: date.toISOString(),
  };
}
