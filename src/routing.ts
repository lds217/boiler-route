import {
  CROSS_RISK_SEC, ICE_STEPS_FACTOR, ICE_TEMP_C, INDOOR_FACTOR, JAYWALK_RISK_FACTOR, NIGHT_CROSS_RISK_FACTOR,
  NIGHT_LIT_FACTOR, ROAD_FACTOR, SEC, STEPS_FACTOR, WALK_SPEED,
} from './constants';
import { feelsLike, INDOOR_C, rainStress, stress } from './comfort';
import type { Edge, Model, RouteContext, RouteSummary, SunPosition, Wind } from './types';

/** Streets worth naming in a warning when the route crosses them. */
const MAJOR_CROSS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);

const CROSS_SEC: Record<string, number> = {
  signal: SEC.signalCrossing, marked: SEC.markedCrossing, plain: SEC.plainCrossing, jaywalk: SEC.jaywalk,
};

export function edgeTime(e: Edge, ctx?: RouteContext): number {
  if (e.kind !== 'outdoor') return (e.len * INDOOR_FACTOR) / WALK_SPEED + (e.doorSec || 0);
  // Icy outdoor stairs are genuinely slower, so this belongs in the time, not the penalty.
  const ice = ctx?.icy && e.steps && !e.covered ? ICE_STEPS_FACTOR : 1;
  return (e.len / WALK_SPEED) * (e.steps ? STEPS_FACTOR : 1) * (e.road ? ROAD_FACTOR : 1) * ice +
    (e.crossing ? CROSS_SEC[e.crossing.type] || 0 : 0);
}

/**
 * Seconds-equivalent for stepping into traffic. Scales with what is crossed, so
 * a detour to a signal beats sprinting across a four-lane road, while dodging
 * round a service drive stays cheap.
 */
export function crossRisk(e: Edge, ctx: RouteContext): number {
  if (!e.crossing) return 0;
  const base = CROSS_RISK_SEC[e.crossing.klass ?? 'residential'] ?? CROSS_RISK_SEC.unclassified;
  return base * (e.crossing.type === 'jaywalk' ? JAYWALK_RISK_FACTOR : 1) * (ctx.night ? NIGHT_CROSS_RISK_FACTOR : 1);
}

/** After dark, prefer paths OSM says are lit; unmapped lighting sits in between. */
export function litFactor(e: Edge, ctx: RouteContext): number {
  if (!ctx.night || e.kind !== 'outdoor' || e.covered) return 1;
  return e.lit === true ? NIGHT_LIT_FACTOR.yes : e.lit === false ? NIGHT_LIT_FACTOR.no : NIGHT_LIT_FACTOR.unknown;
}

/** One-way door edges: hub->door needs exit, door->hub needs enter. */
export const allowed = (e: Edge, u: string): boolean =>
  !e.dir || (e.dir === 'ab' && u === e.a) || (e.dir === 'ba' && u === e.b);

export function edgeCost(e: Edge, ctx: RouteContext, u: string): number {
  if (!allowed(e, u)) return Infinity;
  if (ctx.stepFree && (e.steps || e.stepFree === false)) return Infinity;
  if (ctx.noJaywalk && e.crossing && e.crossing.type === 'jaywalk') return Infinity;
  if (e.kind !== 'outdoor') {
    const blds = e.kind === 'indoor' ? [e.bld] : [e.bldA, e.bldB].filter(Boolean);
    if (blds.some((id) => id && !ctx.open[id])) return Infinity;
    // "no cutting through": indoors is only for the buildings you start or end in
    if (ctx.noCutThrough && blds.some((id) => id && !ctx.throughOk.has(id))) return Infinity;
    const st = blds.length && blds[0] && ctx.indoorStress[blds[0]] !== undefined
      ? Math.max(...blds.map((id) => (id ? ctx.indoorStress[id] ?? ctx.defaultIndoorStress : ctx.defaultIndoorStress)))
      : ctx.defaultIndoorStress;
    return edgeTime(e, ctx) * (1 + ctx.w * st);
  }
  // Safety terms apply at every comfort setting: even the fastest route should
  // not send someone across a highway in the dark to save a few seconds.
  return edgeTime(e, ctx) * (1 + ctx.w * ctx.stress[e.id]) * litFactor(e, ctx) + crossRisk(e, ctx);
}

class Heap {
  private a: [number, string][] = [];
  push(k: number, v: string): void {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, string] {
    const a = this.a;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size(): number { return this.a.length; }
}

export function dijkstra(model: Model, src: string, dst: string, ctx: RouteContext): Edge[] | null {
  const { adj } = model;
  const d: Record<string, number> = {}, prev: Record<string, { e: Edge; from: string }> = {};
  d[src] = 0;
  const h = new Heap();
  h.push(0, src);
  while (h.size) {
    const [du, u] = h.pop();
    if (du > d[u]) continue;
    if (u === dst) break;
    for (const e of adj[u]) {
      const v = e.a === u ? e.b : e.a;
      const c = edgeCost(e, ctx, u);
      if (!isFinite(c)) continue;
      const nd = du + c;
      if (nd < (d[v] ?? Infinity)) { d[v] = nd; prev[v] = { e, from: u }; h.push(nd, v); }
    }
  }
  if (!(dst in d)) return null;
  const path: Edge[] = [];
  let cur = dst;
  while (cur !== src) { const p = prev[cur]; path.unshift(p.e); cur = p.from; }
  return path;
}

export function summarize(path: Edge[], ctx: RouteContext): RouteSummary {
  let len = 0, time = 0, outdoorLen = 0, sunLen = 0, indoorLen = 0;
  let worst: number | null = null, crossings = 0, jaywalks = 0, assumedDoors = 0;
  let unlitLen = 0, majorCrossings = 0;
  let lastCross: string | null = null;
  const via = new Set<string>();
  let unverified = false;
  for (const e of path) {
    len += e.len;
    time += edgeTime(e, ctx);
    if (e.kind === 'outdoor') {
      outdoorLen += e.len;
      sunLen += e.len * ctx.sunFrac[e.id];
      const f = ctx.feels[e.id];
      if (worst === null || (ctx.hot ? f > worst : f < worst)) worst = f;
      // Consecutive crossing edges of the same street count as one crossing.
      if (ctx.night && !e.covered && e.lit !== true) unlitLen += e.len;
      const ck = e.crossing ? (e.crossing.type === 'jaywalk' ? 'j:' : 'c:') + (e.crossing.street || '') : null;
      if (ck && ck !== lastCross) {
        if (e.crossing!.type === 'jaywalk') jaywalks++;
        else crossings++;
        if (MAJOR_CROSS.has(e.crossing!.klass ?? '')) majorCrossings++;
      }
      lastCross = ck;
    } else {
      indoorLen += e.len;
      if (e.bld) via.add(e.bld);
      if (e.bldA) { via.add(e.bldA); via.add(e.bldB!); }
      if (e.verified === false) unverified = true;
      for (const d of [e.door, e.doorA, e.doorB]) if (d && d.assumed) assumedDoors++;
    }
  }
  return {
    len, time, outdoorLen, sunLen, shadeLen: outdoorLen - sunLen, indoorLen,
    via: [...via], unverified, worst, crossings, jaywalks, assumedDoors,
    unlitLen, majorCrossings,
  };
}

export interface ContextInputs {
  sunFrac: Float32Array;
  sun: SunPosition;
  tempC: number;
  wind: Wind;
  cloudPct: number;
  w: number;
  open: Record<string, boolean>;
  stepFree: boolean;
  noJaywalk: boolean;
  mins: number;
  /** Rain or melted snow, mm/h. Adds stress wherever there is no cover. */
  precipMm?: number;
  /** Route outdoors except through the endpoint buildings themselves. */
  noCutThrough?: boolean;
  /** Buildings the route may still pass through: normally origin and destination. */
  throughOk?: string[];
}

/** Precompute per-edge feels-like and stress, and per-building indoor stress. */
export function buildContext(model: Model, inp: ContextInputs): RouteContext {
  const feels = new Float32Array(model.edges.length);
  const st = new Float32Array(model.edges.length);
  const rain = rainStress(inp.precipMm ?? 0);
  for (const e of model.edges)
    if (e.kind === 'outdoor') {
      feels[e.id] = feelsLike(inp.tempC, inp.sunFrac[e.id], inp.sun.alt, inp.wind, inp.cloudPct);
      st[e.id] = stress(feels[e.id]) + (e.covered ? 0 : rain);
    }
  const indoorStress: Record<string, number> = {};
  const defaultIndoorStress = stress(INDOOR_C);
  for (const b of model.buildings) {
    // Unconditioned buildings feel like the outdoor air (no sun, no wind).
    const t = b.indoorC === null ? inp.tempC : b.indoorC;
    indoorStress[b.id] = stress(t);
  }
  return {
    w: inp.w, sunFrac: inp.sunFrac, feels, stress: st,
    indoorStress, defaultIndoorStress,
    open: inp.open, hot: inp.tempC >= 18, tC: inp.tempC,
    stepFree: inp.stepFree, noJaywalk: inp.noJaywalk, mins: inp.mins,
    night: inp.sun.alt <= 0, icy: inp.tempC <= ICE_TEMP_C, precipMm: inp.precipMm ?? 0,
    noCutThrough: inp.noCutThrough ?? false, throughOk: new Set(inp.throughOk ?? []),
  };
}
