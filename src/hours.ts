/**
 * opening_hours: handles the common simple forms, e.g.
 * "Mo-Fr 07:00-22:00; Sa 08:00-17:00", "24/7".
 * Returns [open, close] in decimal hours for the given weekday (0 = Sunday), or null.
 */
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function parseHours(spec: string | undefined | null, weekday: number): [number, number] | null {
  if (!spec) return null;
  spec = spec.trim();
  if (spec === '24/7') return [0, 24];
  for (const rule of spec.split(';')) {
    const r = rule.trim();
    if (!r) continue;
    const m = r.match(/^((?:[A-Z][a-z](?:-[A-Z][a-z])?(?:,\s*)?)+)?\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) continue;
    let applies = true;
    if (m[1]) {
      applies = false;
      for (const part of m[1].split(',')) {
        const [a, b] = part.trim().split('-');
        const ia = DAYS.indexOf(a), ib = b ? DAYS.indexOf(b) : ia;
        if (ia < 0) continue;
        for (let d = ia; ; d = (d + 1) % 7) {
          if (d === weekday) applies = true;
          if (d === ib) break;
        }
      }
    }
    if (applies) return [+m[2] + +m[3] / 60, +m[4] + +m[5] / 60];
  }
  return null;
}

export const fmtClock = (mins: number): string => {
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

export const fmtHours = (h: [number, number]): string =>
  `${fmtClock(Math.round(h[0] * 60))} to ${fmtClock(Math.round(h[1] * 60) % 1440)}`;

import type { Building } from './types';
import { DEFAULT_HOURS } from './constants';

/**
 * Re-evaluate opening hours for the queried weekday and return which buildings
 * are open at the given decimal hour. Mutates b.hours/b.hoursTagged so the UI
 * shows the hours that were actually used.
 */
export function computeOpen(buildings: Building[], weekday: number, hour: number): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  for (const b of buildings) {
    const osm = parseHours(b.tags.opening_hours, weekday);
    const hrs = b.hoursOverride ?? osm ?? DEFAULT_HOURS;
    b.hours = hrs;
    b.hoursTagged = !!(b.hoursOverride || osm);
    open[b.id] = hour >= hrs[0] && hour < hrs[1];
  }
  return open;
}
