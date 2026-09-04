import { describe, expect, it } from 'vitest';
import { cToF, feelsLike, fToC, stress, windClass } from '../src/comfort';
import { angDiff, bboxOf, centroid, createProjection, dist, hull, pointInRing, segIntersects } from '../src/geometry';
import { computeOpen, fmtClock, parseHours } from '../src/hours';
import { sunPosition } from '../src/sun';
import { BBOX } from '../src/constants';

describe('geometry', () => {
  const rect = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }];
  it('centroid of a rectangle is its centre', () => {
    const c = centroid(rect);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(3);
  });
  it('pointInRing', () => {
    expect(pointInRing({ x: 5, y: 3 }, rect)).toBe(true);
    expect(pointInRing({ x: 11, y: 3 }, rect)).toBe(false);
  });
  it('segIntersects: proper crossing yes, endpoint touch no', () => {
    expect(segIntersects({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segIntersects({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 0 })).toBe(false);
  });
  it('hull of a square with an interior point drops the interior point', () => {
    expect(hull([...rect, { x: 5, y: 3 }])).toHaveLength(4);
  });
  it('angDiff wraps correctly', () => {
    expect(angDiff(350, 10)).toBe(20);
    expect(angDiff(10, 350)).toBe(-20);
  });
  it('projection round-trips metres', () => {
    const proj = createProjection(BBOX);
    const [lat, lon] = proj.ll({ x: 123, y: -77 });
    const p = proj.xy(lat, lon);
    expect(dist(p, { x: 123, y: -77 })).toBeLessThan(0.01);
  });
  it('bboxOf', () => {
    expect(bboxOf(rect)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 6 });
  });
});

describe('opening hours', () => {
  it('parses 24/7', () => expect(parseHours('24/7', 2)).toEqual([0, 24]));
  it('parses weekday ranges per day', () => {
    const spec = 'Mo-Fr 07:00-22:00; Sa-Su 09:00-17:00';
    expect(parseHours(spec, 3)).toEqual([7, 22]); // Wednesday
    expect(parseHours(spec, 6)).toEqual([9, 17]); // Saturday
    expect(parseHours(spec, 0)).toEqual([9, 17]); // Sunday
  });
  it('returns null for unparseable specs', () => {
    expect(parseHours('sunrise-sunset', 1)).toBeNull();
    expect(parseHours(undefined, 1)).toBeNull();
  });
  it('fmtClock', () => {
    expect(fmtClock(0)).toBe('12:00 am');
    expect(fmtClock(13 * 60 + 5)).toBe('1:05 pm');
  });
});

describe('comfort model', () => {
  it('no stress in the comfortable band', () => {
    expect(stress(20)).toBe(0);
    expect(stress(22)).toBe(0);
    expect(stress(26)).toBe(0);
  });
  it('piecewise-linear between UTCI bands', () => {
    expect(stress(29)).toBeCloseTo(0.75); // halfway 26→32 (0→1.5)
    expect(stress(-6.5)).toBeCloseTo(2.25); // halfway -13→0 (3→1.5)
  });
  it('clamps at the extremes', () => {
    expect(stress(-60)).toBe(8);
    expect(stress(80)).toBe(8);
  });
  it('sun adds nothing at night', () => {
    expect(feelsLike(30, 1, -0.1, 'calm', 0)).toBeCloseTo(30);
  });
  it('full sun at zenith adds SUN_MAX_C on a clear day', () => {
    expect(feelsLike(30, 1, Math.PI / 2, 'calm', 0)).toBeCloseTo(40);
  });
  it('overcast cuts the sun term by 75%', () => {
    expect(feelsLike(30, 1, Math.PI / 2, 'calm', 100)).toBeCloseTo(32.5);
  });
  it('wind chills cold air more than warm air', () => {
    const cold = 0 - feelsLike(0, 0, 0.5, 'windy', 0);
    const warm = 30 - feelsLike(30, 0, 0.5, 'windy', 0);
    expect(cold).toBeGreaterThan(warm);
  });
  it('unit conversions round-trip', () => {
    expect(cToF(fToC(84))).toBeCloseTo(84);
    expect(windClass(5)).toBe('calm');
    expect(windClass(10)).toBe('breezy');
    expect(windClass(20)).toBe('windy');
  });
});

describe('sun position', () => {
  const lat = (BBOX[0] + BBOX[2]) / 2, lon = (BBOX[1] + BBOX[3]) / 2;
  it('is high and southern on an August midday', () => {
    const s = sunPosition(new Date(Date.UTC(2026, 7, 26, 18, 0)), lat, lon); // 2 pm EDT
    expect(s.alt).toBeGreaterThan(0.8); // > ~46°
    expect(Math.abs(s.bearing - Math.PI)).toBeLessThan(Math.PI / 2); // broadly southern
  });
  it('is below the horizon at night', () => {
    const s = sunPosition(new Date(Date.UTC(2026, 7, 26, 6, 0)), lat, lon); // 2 am EDT
    expect(s.alt).toBeLessThan(0);
  });
  it('is low on a January midday', () => {
    const s = sunPosition(new Date(Date.UTC(2026, 0, 15, 18, 0)), lat, lon); // 1 pm EST
    expect(s.alt).toBeGreaterThan(0.2);
    expect(s.alt).toBeLessThan(0.6);
  });
});

describe('computeOpen', () => {
  it('is exercised via the fixture models in graph.test.ts', () => {
    expect(typeof computeOpen).toBe('function');
  });
});
