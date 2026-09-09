/**
 * Where you are along a route, so the map can drop what you have walked and the
 * directions can keep up with you.
 *
 * The solver returns edges, not a direction of travel, so everything here works
 * from legs: the same edges walked in order from the start. Distances are plain
 * geometry (what you see on the map), while remaining time asks the caller for
 * the cost model's own per-edge time, which is not the same thing indoors.
 */
import type { Edge, Model, XY } from './types';

export interface Leg { e: Edge; a: XY; b: XY; len: number }

export function orderedLegs(model: Model, path: Edge[], srcNode: string): Leg[] {
  const legs: Leg[] = [];
  let cur = srcNode;
  for (const e of path) {
    const to = e.a === cur ? e.b : e.a;
    const a = model.nodes[cur], b = model.nodes[to];
    if (!a || !b) break;
    legs.push({ e, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, len: Math.hypot(b.x - a.x, b.y - a.y) });
    cur = to;
  }
  return legs;
}

export interface Progress {
  /** Metres from the start, measured along the route. */
  along: number;
  total: number;
  /** How far off the route you are: the reroute trigger. */
  off: number;
  leg: number;
}

/** Nearest point on the route to p. */
export function progressOn(legs: Leg[], p: XY): Progress | null {
  let best: Progress | null = null, acc = 0, total = 0;
  for (let i = 0; i < legs.length; i++) {
    const { a, b, len } = legs[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const off = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (!best || off < best.off) best = { along: acc + t * len, total: 0, off, leg: i };
    acc += len;
  }
  total = acc;
  if (best) best.total = total;
  return best;
}

/** The route still ahead, split at `along`, ready to draw. */
export function remainingRuns(legs: Leg[], along: number): { e: Edge; a: XY; b: XY }[] {
  const out: { e: Edge; a: XY; b: XY }[] = [];
  let acc = 0;
  for (const l of legs) {
    const end = acc + l.len;
    if (end > along) {
      const t = along > acc && l.len ? (along - acc) / l.len : 0;
      out.push({
        e: l.e,
        a: t > 0 ? { x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t } : l.a,
        b: l.b,
      });
    }
    acc = end;
  }
  return out;
}

/** Seconds left, prorating the leg you are standing on. */
export function remainingTime(legs: Leg[], along: number, timeOf: (e: Edge) => number): number {
  let acc = 0, secs = 0;
  for (const l of legs) {
    const end = acc + l.len;
    if (end > along) {
      const done = along > acc && l.len ? (along - acc) / l.len : 0;
      secs += timeOf(l.e) * (1 - done);
    }
    acc = end;
  }
  return secs;
}

/** Distance along the route of each turn, so the banner can follow you. */
export function stepDistances(legs: Leg[], ats: XY[]): number[] {
  return ats.map((at) => progressOn(legs, at)?.along ?? 0);
}
