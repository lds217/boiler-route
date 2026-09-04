import { MAX_SHADOW } from './constants';
import { hull, pointInRing, rayHitsRing } from './geometry';
import type { Model, SunPosition, XY } from './types';

export interface ShadeResult {
  /** Per-edge fraction of samples in direct sun, indexed by edge id. */
  sunFrac: Float32Array;
  /** Drawable shadow polygons (convex hulls; overestimate for concave footprints). */
  shadows: XY[][];
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

  const shaded = (p: XY): boolean => {
    for (const { s, L } of casters) {
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

  const shadows = casters.map(({ s, L }) =>
    hull(s.ring.concat(s.ring.map((c) => ({ x: c.x - u.x * L, y: c.y - u.y * L })))));
  return { sunFrac, shadows };
}
