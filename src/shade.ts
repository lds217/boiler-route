import { MAX_SHADOW } from './constants';
import { hull, pointInRing, rayHitsRing } from './geometry';
import type { Model, SunPosition, XY } from './types';

export interface ShadeResult {
  /** Per-edge fraction of samples in direct sun, indexed by edge id. */
  sunFrac: Float32Array;
  /** Drawable shadow pieces. Overlapping pieces are meant to be filled as one
   *  path with the nonzero rule, which unions them. */
  shadows: XY[][];
}

/** A ring turns the same way at every corner only if it is convex. */
function isConvex(r: XY[]): boolean {
  let sign = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], c = r[(i + 2) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * The ground a caster shades is its footprint swept along the sun-opposite
 * vector. For a convex footprint that sweep is exactly the hull of the shape and
 * its translated copy, so those stay one ring. A concave footprint must be
 * emitted in pieces -- the shape, its copy, and one quad per wall -- because a
 * hull would fill in the courtyards and notches that are actually in full sun,
 * and 81% of the footprints here are concave.
 */
function shadowPieces(ring: XY[], dx: number, dy: number): XY[][] {
  const moved = ring.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (isConvex(ring)) return [hull(ring.concat(moved))];
  const out: XY[][] = [ring, moved];
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out.push([a, b, { x: b.x + dx, y: b.y + dy }, { x: a.x + dx, y: a.y + dy }]);
  }
  return out;
}

/**
 * SHADE MODEL: sample 5 points along each outdoor edge; a point is shaded if a
 * ray toward the sun, as long as the caster's shadow, enters any caster.
 */
export function computeShade(model: Model, sun: SunPosition): ShadeResult {
  const { edges, nodes, buildings, trees } = model;
  const sunFrac = new Float32Array(edges.length);
  if (sun.alt <= 0) return { sunFrac, shadows: [] }; // night: no sun anywhere, no shadows

  const u = { x: Math.sin(sun.bearing), y: Math.cos(sun.bearing) };
  const tanAlt = Math.tan(sun.alt);
  const casters = [...buildings, ...trees].map((s) => ({ s, L: Math.min(s.height / tanAlt, MAX_SHADOW) }));

  /*
   * A point is shaded when some caster sits between it and the sun, so the only
   * points a caster can shade lie within L of it, opposite the sun direction.
   * Bucketing casters into that footprint turns the per-sample scan over every
   * caster into a lookup of the few that can possibly matter.
   */
  const CELL = 64; // m
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 100000 + cy;
  casters.forEach(({ s, L }, i) => {
    const x0 = Math.min(s.bbox.x0, s.bbox.x0 - u.x * L), x1 = Math.max(s.bbox.x1, s.bbox.x1 - u.x * L);
    const y0 = Math.min(s.bbox.y0, s.bbox.y0 - u.y * L), y1 = Math.max(s.bbox.y1, s.bbox.y1 - u.y * L);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = key(cx, cy);
        let lst = grid.get(k);
        if (!lst) { lst = []; grid.set(k, lst); }
        lst.push(i);
      }
  });

  const shaded = (p: XY): boolean => {
    const lst = grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL)));
    if (!lst) return false;
    for (const i of lst) {
      const { s, L } = casters[i];
      if (p.x < s.bbox.x0 - L || p.x > s.bbox.x1 + L || p.y < s.bbox.y0 - L || p.y > s.bbox.y1 + L) continue;
      const q = { x: p.x + u.x * L, y: p.y + u.y * L };
      if (pointInRing(p, s.ring) || rayHitsRing(p, q, s.ring)) return true;
    }
    return false;
  };

  for (const e of edges) {
    if (e.kind !== 'outdoor') continue;
    if (e.covered) { sunFrac[e.id] = 0; continue; }
    const A = nodes[e.a], B = nodes[e.b];
    let sunny = 0;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9])
      if (!shaded({ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f })) sunny++;
    sunFrac[e.id] = sunny / 5;
  }

  const shadows = casters.flatMap(({ s, L }) => shadowPieces(s.ring, -u.x * L, -u.y * L));
  return { sunFrac, shadows };
}
