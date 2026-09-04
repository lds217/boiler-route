import type { BBoxXY, LatLonBBox, RingPoint, XY } from './types';

/**
 * Local equirectangular projection in metres, relative to the bbox centre.
 * Good enough for a campus-sized area (~1 km).
 */
export interface Projection {
  centerLat: number;
  centerLon: number;
  mlat: number;
  mlon: number;
  xy(lat: number, lon: number): XY;
  ll(p: XY): [number, number]; // [lat, lon]
}

export function createProjection(bbox: LatLonBBox): Projection {
  const centerLat = (bbox[0] + bbox[2]) / 2;
  const centerLon = (bbox[1] + bbox[3]) / 2;
  const mlat = 111320;
  const mlon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return {
    centerLat, centerLon, mlat, mlon,
    xy: (lat, lon) => ({ x: (lon - centerLon) * mlon, y: (lat - centerLat) * mlat }),
    ll: (p) => [centerLat + p.y / mlat, centerLon + p.x / mlon],
  };
}

export const dist = (a: XY, b: XY): number => Math.hypot(a.x - b.x, a.y - b.y);

export const bboxOf = (ring: XY[]): BBoxXY => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of ring) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
};

export function centroid(ring: XY[]): XY {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const b = bboxOf(ring);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSeg(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToRing(p: XY, ring: XY[]): number {
  let d = 1e9;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

export function closestOnRing(p: XY, ring: XY[]): XY {
  let best: XY = ring[0], bd = 1e9;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

export function segIntersects(p: XY, q: XY, r: XY, s: XY): boolean {
  const d = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

export function rayHitsRing(p: XY, q: XY, ring: XY[]): boolean {
  for (let i = 0; i < ring.length; i++) if (segIntersects(p, q, ring[i], ring[(i + 1) % ring.length])) return true;
  return false;
}

/** Convex hull (monotone chain). */
export function hull<T extends XY>(pts: T[]): T[] {
  const P = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: T[] = [], up: T[] = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Bearing in degrees, 0 = north, clockwise. */
export const bearingDeg = (A: XY, B: XY): number => ((Math.atan2(B.x - A.x, B.y - A.y) * 180) / Math.PI + 360) % 360;

const OCTANTS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const compass8 = (bearing: number): string => OCTANTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

const OCTANTS_SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Short octant from a bearing in radians. */
export const compassShort = (bearingRad: number): string => OCTANTS_SHORT[Math.round(bearingRad / (Math.PI / 4)) % 8];

export const angDiff = (a: number, b: number): number => ((b - a + 540) % 360) - 180;
