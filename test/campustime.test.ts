import { describe, expect, it } from 'vitest';
import { campusClock, campusInstant, weekdayOf } from '../src/campustime';
import { BBOX } from '../src/constants';
import { sunPosition } from '../src/sun';

const iso = (d: Date) => d.toISOString();
const LAT = (BBOX[0] + BBOX[2]) / 2, LON = (BBOX[1] + BBOX[3]) / 2;
const deg = (r: number) => (r * 180) / Math.PI;

// These results must not depend on the device's zone. To check that, run the
// suite under other zones too, e.g. TZ=Asia/Ho_Chi_Minh npx vitest run.
describe('campusInstant: campus wall clock to a real instant', () => {
  it('uses EDT (UTC-4) in summer and EST (UTC-5) in winter', () => {
    expect(iso(campusInstant('2026-06-21', 13 * 60 + 40))).toBe('2026-06-21T17:40:00.000Z');
    expect(iso(campusInstant('2026-11-22', 12 * 60 + 30))).toBe('2026-11-22T17:30:00.000Z');
    expect(iso(campusInstant('2026-11-22', 0))).toBe('2026-11-22T05:00:00.000Z');
  });

  it('handles the spring-forward gap by moving to the hour after', () => {
    expect(iso(campusInstant('2026-03-08', 60))).toBe('2026-03-08T06:00:00.000Z'); // 01:00 EST
    expect(iso(campusInstant('2026-03-08', 150))).toBe('2026-03-08T07:30:00.000Z'); // 02:30 does not exist: 03:30 EDT
    expect(iso(campusInstant('2026-03-08', 180))).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
    expect(iso(campusInstant('2026-03-09', 30))).toBe('2026-03-09T04:30:00.000Z'); // the day after
  });

  it('takes the first of the two 01:30s when clocks fall back', () => {
    expect(iso(campusInstant('2026-11-01', 90))).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(iso(campusInstant('2026-11-01', 180))).toBe('2026-11-01T08:00:00.000Z'); // 03:00 EST
  });

  it('gives an Invalid Date for a half-typed date', () => {
    for (const s of ['', '2026-11-', '2026-1-22', 'not a date'])
      expect(Number.isNaN(campusInstant(s, 600).getTime())).toBe(true);
    expect(Number.isNaN(campusInstant('2026-11-22', NaN).getTime())).toBe(true);
  });
});

describe('campusClock: a real instant to the campus wall clock', () => {
  it('reads the campus date, not the UTC date, late in the evening', () => {
    expect(campusClock(new Date('2026-11-23T03:00:00Z'))).toEqual({ dateStr: '2026-11-22', mins: 22 * 60, weekday: 0 });
    expect(campusClock(new Date('2026-06-21T17:40:00Z'))).toEqual({ dateStr: '2026-06-21', mins: 13 * 60 + 40, weekday: 0 });
  });

  it('round-trips every slider position, including both DST change days', () => {
    for (const d of ['2026-03-08', '2026-06-21', '2026-11-01', '2026-11-22'])
      for (let m = 0; m < 1440; m += 15) {
        if (d === '2026-03-08' && m >= 120 && m < 180) continue; // the hour that does not exist
        expect(campusClock(campusInstant(d, m))).toMatchObject({ dateStr: d, mins: m });
      }
  });
});

describe('weekdayOf', () => {
  it('names the weekday of the calendar date', () => {
    expect(weekdayOf('2026-11-22')).toBe(0);
    expect(weekdayOf('2026-11-23')).toBe(1);
    expect(weekdayOf('2026-02-28')).toBe(6);
    expect(weekdayOf('2026-11-')).toBeNaN();
  });
});

describe('the sun at campus clock times', () => {
  it('is due south around 12:35 in November', () => {
    const s = sunPosition(campusInstant('2026-11-22', 12 * 60 + 35), LAT, LON);
    expect(Math.abs(deg(s.bearing) - 180)).toBeLessThan(2);
    expect(deg(s.alt)).toBeCloseTo(90 - LAT - 20.2, 0); // declination about -20.2° that day
  });

  it('is near its June peak at 13:40 and below the horizon at 23:00', () => {
    expect(deg(sunPosition(campusInstant('2026-06-21', 13 * 60 + 40), LAT, LON).alt)).toBeGreaterThan(72);
    expect(sunPosition(campusInstant('2026-06-21', 23 * 60), LAT, LON).alt).toBeLessThan(0);
  });
});
