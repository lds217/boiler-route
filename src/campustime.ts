import { CAMPUS_TZ } from './constants';

/**
 * CAMPUS TIME
 * The date picker and time slider mean the wall clock on campus, whatever zone
 * the device is set to: that is what the weather (Open-Meteo, timezone=auto)
 * and the opening hours already assume. These helpers convert between that
 * wall clock and real instants, so the sun is computed for the right moment.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(instant: Date, tz: string): Record<string, number> {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(instant)) if (p.type !== 'literal') out[p.type] = +p.value;
  out.hour %= 24; // some engines still print midnight as 24
  return out;
}

/** Minutes the zone's wall clock is ahead of UTC at this instant (EST = -300). */
function offsetMin(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime()) / 60000;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant at which the campus clock reads `dateStr` (YYYY-MM-DD) plus
 * `mins` minutes after midnight. An unparseable date gives an Invalid Date.
 */
export function campusInstant(dateStr: string, mins: number, tz: string = CAMPUS_TZ): Date {
  const m = ISO_DATE.exec(dateStr);
  if (!m || !Number.isFinite(mins)) return new Date(NaN);
  // the wall-clock reading, written as if it were UTC
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, mins);
  if (!Number.isFinite(wall)) return new Date(NaN);
  const DAY = 86400000;
  const before = offsetMin(new Date(wall - DAY), tz), after = offsetMin(new Date(wall + DAY), tz);
  const fits = (o: number) => offsetMin(new Date(wall - o * 60000), tz) === o;
  // Usually the two offsets agree. In the fall-back hour both fit, and the first
  // occurrence wins. In the spring-forward gap neither fits, since that clock
  // time never happens: reading it with the earlier offset lands in the hour
  // after (02:30 becomes 03:30), as Temporal and most calendars do.
  const o = fits(before) ? before : fits(after) ? after : before;
  return new Date(wall - o * 60000);
}

export interface CampusClock {
  /** YYYY-MM-DD on campus */
  dateStr: string;
  /** minutes after campus midnight */
  mins: number;
  /** 0 = Sunday */
  weekday: number;
}

/** What the campus clock reads at this instant. */
export function campusClock(instant: Date = new Date(), tz: string = CAMPUS_TZ): CampusClock {
  const p = parts(instant, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateStr: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    mins: p.hour * 60 + p.minute,
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
  };
}

/** Day of the week (0 = Sunday) of a calendar date, independent of any zone. NaN if unparseable. */
export function weekdayOf(dateStr: string): number {
  const m = ISO_DATE.exec(dateStr);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : NaN;
}
