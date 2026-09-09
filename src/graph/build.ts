import {
  ASSUMED_DOOR_PENALTY_FACTOR, CANOPY_MAX_M, CORRIDOR_FACTOR, CROSSING_MAX_LEN, CROSSING_STREET_REACH,
  DOOR_CONNECT, DOOR_REACH,
  DOOR_SECTORS, DOOR_SNAP, GAP_CLOSE, SEC, STREETS, WALKWAYS,
} from '../constants';
import {
  bearingDeg, closestOnRing, compass8, dist, distToRing, pointInRing, segIntersects, type Projection,
} from '../geometry';
import { doorSpec, extractBuildings, extractCampusPolys, extractTrees, indexOsm } from '../osm/parse';
import type {
  Building, CampusOverrides, Crossing, DoorSpec, Edge, EdgeKind, GraphNode, HeightsData, LinkKind,
  Model, OsmData, OsmTags, StreetSeg, Tree, XY,
} from '../types';

export interface BuildOptions {
  weekday: number;
  overrides?: Partial<CampusOverrides>;
  /** NDHM lidar heights + canopy from scripts/heights.py. */
  heights?: HeightsData | null;
}

const walkableTags = (t: OsmTags): boolean => {
  const acc = t.access, foot = t.foot;
  if (foot && ['yes', 'designated', 'permissive'].includes(foot)) return true;
  if (foot === 'no' || foot === 'private' || foot === 'use_sidepath') return false;
  if (acc && ['private', 'no'].includes(acc)) return false;
  return true;
};

/** Spatial index of street segments for "does this segment cross a street?" checks. */
export class StreetIndex {
  private cell = 25;
  private grid = new Map<string, number[]>();
  constructor(public streets: StreetSeg[]) {
    streets.forEach((s, i) => {
      const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x);
      const y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
      for (let x = Math.floor(x0 / this.cell); x <= Math.floor(x1 / this.cell); x++)
        for (let y = Math.floor(y0 / this.cell); y <= Math.floor(y1 / this.cell); y++) {
          const k = `${x},${y}`;
          let lst = this.grid.get(k);
          if (!lst) { lst = []; this.grid.set(k, lst); }
          lst.push(i);
        }
    });
  }
  crossed(p: XY, q: XY, ignoreNodeIds?: Set<number> | null): StreetSeg | null {
    const seen = new Set<number>();
    const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x);
    const y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
    for (let x = Math.floor(x0 / this.cell); x <= Math.floor(x1 / this.cell); x++)
      for (let y = Math.floor(y0 / this.cell); y <= Math.floor(y1 / this.cell); y++) {
        const lst = this.grid.get(`${x},${y}`);
        if (!lst) continue;
        for (const i of lst) {
          if (seen.has(i)) continue;
          seen.add(i);
          const s = this.streets[i];
          if (ignoreNodeIds && (ignoreNodeIds.has(s.na) || ignoreNodeIds.has(s.nb))) continue;
          if (segIntersects(p, q, s.a, s.b)) return s;
        }
      }
    return null;
  }

  /**
   * Nearest street to a point, for crossing edges drawn just short of the
   * carriageway: without this they fall back to a generic class and are priced
   * as if they crossed a quiet residential street.
   */
  nearest(p: XY, maxDist: number): StreetSeg | null {
    let best: StreetSeg | null = null, bd = maxDist * maxDist;
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    const seen = new Set<number>();
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        const lst = this.grid.get(`${x},${y}`);
        if (!lst) continue;
        for (const i of lst) {
          if (seen.has(i)) continue;
          seen.add(i);
          const s = this.streets[i];
          const d = distToSegSq(p, s.a, s.b);
          if (d < bd) { bd = d; best = s; }
        }
      }
    return best;
  }
}

function distToSegSq(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return (p.x - qx) ** 2 + (p.y - qy) ** 2;
}

export function buildModel(osm: OsmData, proj: Projection, opts: BuildOptions): Model {
  const idx = indexOsm(osm);
  const overrides = opts.overrides ?? {};
  const campusPolys = extractCampusPolys(idx, proj);
  const buildings = extractBuildings(idx, proj, opts.weekday, overrides.buildings ?? {}, opts.heights?.buildings ?? {}, campusPolys);
  // Lidar canopy supersedes OSM tree points, but only where the tiles actually
  // reach: outside that coverage OSM trees stay, or the uncovered ground would
  // route as treeless full sun.
  const canopy = opts.heights?.canopy ?? [];
  const cov = opts.heights?.coverage;
  const trees: Tree[] = canopy.length
    ? canopy.filter((c) => c.h <= CANOPY_MAX_M).map((c, i): Tree => {
        const p = proj.xy(c.lat, c.lon);
        const ring: XY[] = [];
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * 2 * Math.PI;
          ring.push({ x: p.x + c.r * Math.cos(a), y: p.y + c.r * Math.sin(a) });
        }
        return {
          id: 'c' + i, c: p, r: c.r, height: c.h, ring,
          bbox: { x0: p.x - c.r, y0: p.y - c.r, x1: p.x + c.r, y1: p.y + c.r },
        };
      })
    : extractTrees(idx, proj);
  if (canopy.length && cov?.length) {
    for (const t of extractTrees(idx, proj)) {
      const [lat, lon] = proj.ll(t.c);
      const covered = cov.some((b) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);
      if (!covered) trees.push(t);
    }
  }
  const bInside = (p: XY): Building | undefined =>
    buildings.find((b) => p.x >= b.bbox.x0 && p.x <= b.bbox.x1 && p.y >= b.bbox.y0 && p.y <= b.bbox.y1 && pointInRing(p, b.ring));

  // ---- streets (for jaywalk checks) and the walkable graph ----
  const streets: StreetSeg[] = [];
  const nodes: Record<string, GraphNode> = {};
  const edges: Edge[] = [];
  const addNode = (id: string, p: XY, kind: GraphNode['kind'], bld: string | null): GraphNode =>
    nodes[id] || (nodes[id] = { id, x: p.x, y: p.y, kind, bld, deg: 0 });
  const addEdge = (a: string, b: string, kind: EdgeKind, extra: Partial<Edge> = {}): Edge => {
    const e: Edge = { id: edges.length, a, b, kind, len: dist(nodes[a], nodes[b]), ...extra };
    edges.push(e);
    nodes[a].deg++; nodes[b].deg++;
    return e;
  };

  for (const idStr in idx.ways) {
    const w = idx.ways[idStr];
    if (!w.tags || !w.tags.highway) continue;
    const t = w.tags, hw = t.highway;
    const pts = w.nodes.map((nid) => idx.nodes[nid]).filter(Boolean);
    if (STREETS.has(hw)) {
      for (let i = 0; i < pts.length - 1; i++)
        streets.push({
          a: proj.xy(pts[i].lat, pts[i].lon), b: proj.xy(pts[i + 1].lat, pts[i + 1].lon),
          na: pts[i].id, nb: pts[i + 1].id,
          name: t.name || hw.replace('_', ' '), klass: hw, osmWay: +idStr,
        });
      // A street carriageway is never walked along: routes use footways, paths,
      // steps, pedestrian ways and mapped crossings only. Streets are kept here
      // solely to detect crossings and price the risk of stepping into one.
      continue;
    } else if (!WALKWAYS.has(hw) || !walkableTags(t)) continue;

    let kind: EdgeKind = 'outdoor';
    let linkKind: LinkKind | null = null;
    if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') { kind = 'link'; linkKind = 'subwalk'; }
    else if (hw === 'corridor' || t.indoor === 'yes' || t.indoor === 'corridor') kind = 'indoor';
    else if (t.bridge && t.bridge !== 'no' && (t.covered === 'yes' || t.indoor)) { kind = 'link'; linkKind = 'skywalk'; }
    const covered = t.covered === 'yes' || t.tunnel === 'building_passage';
    const lit = t.lit === 'yes' || t.lit === '24/7' ? true : t.lit === 'no' ? false : null;
    const isCrossingWay = t.footway === 'crossing' || t.path === 'crossing' || t.cycleway === 'crossing' || !!t.crossing;
    const name = t.name || null;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const pa = proj.xy(a.lat, a.lon), pb = proj.xy(b.lat, b.lon);
      addNode('n' + a.id, pa, 'path', null);
      addNode('n' + b.id, pb, 'path', null);
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      let k = kind, bld: string | null = null;
      let cov = covered;
      // A mapped corridor, or any path whose midpoint is inside a footprint, is
      // indoor for that building. Off-campus buildings are not enterable — a
      // path through one stays outdoor but counts as covered (no sun).
      if (k === 'indoor' || k === 'outdoor') {
        const inB = bInside(mid);
        if (inB?.campus) { k = 'indoor'; bld = inB.id; }
        else if (inB) { k = 'outdoor'; cov = true; }
      }
      if (k === 'indoor' && !bld) k = 'link';
      let crossing: Crossing | null = null;
      if (k === 'outdoor') {
        const cn = [a, b].map((n) => (n.tags && n.tags.highway === 'crossing' ? n.tags : null)).find(Boolean);
        const ct = (cn && cn.crossing) || t.crossing || null;
        if (cn || isCrossingWay) crossing = { type: ct === 'traffic_signals' ? 'signal' : ct === 'unmarked' ? 'plain' : 'marked' };
      }
      addEdge('n' + a.id, 'n' + b.id, k, {
        bld, linkKind: k === 'link' ? linkKind || 'corridor' : null,
        covered: cov, name, lit, osmWay: +idStr, steps: hw === 'steps', crossing,
      });
    }
  }
  const pathNodes = Object.values(nodes).filter((n) => n.kind === 'path');
  const sIndex = new StreetIndex(streets);

  // A footway drawn across a street with no shared node is a jaywalk in the data.
  // Keep it, price it heavily, name it.
  let jaywalks = 0;
  for (const e of edges) {
    if (e.kind !== 'outdoor' || e.crossing) continue;
    const ids = new Set([+e.a.slice(1), +e.b.slice(1)]);
    const s = sIndex.crossed(nodes[e.a], nodes[e.b], ids);
    if (s) { e.crossing = { type: 'jaywalk', street: s.name, klass: s.klass }; jaywalks++; }
  }
  const streetAtNode = (id: string): StreetSeg | undefined => {
    const n = +String(id).slice(1);
    return streets.find((s) => s.na === n || s.nb === n);
  };
  for (const e of edges) {
    if (!e.crossing) continue;
    const crossed = sIndex.crossed(nodes[e.a], nodes[e.b], null);
    // A crossing node marks a point, not a whole way: an edge that only touches
    // one and never reaches the carriageway is just a footway leading up to it.
    if (!crossed && e.len > CROSSING_MAX_LEN) { e.crossing = null; continue; }
    if (e.crossing.street) continue;
    const mid = { x: (nodes[e.a].x + nodes[e.b].x) / 2, y: (nodes[e.a].y + nodes[e.b].y) / 2 };
    const s = crossed || streetAtNode(e.a) || streetAtNode(e.b) || sIndex.nearest(mid, CROSSING_STREET_REACH);
    if (s) { e.crossing.street = s.name; e.crossing.klass = s.klass; }
  }

  // ---- close small gaps, never across a street ----
  const cell = 10, grid = new Map<string, GraphNode[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const n of pathNodes) {
    const k = key(n.x, n.y);
    let lst = grid.get(k);
    if (!lst) { lst = []; grid.set(k, lst); }
    lst.push(n);
  }
  let gapsClosed = 0;
  for (const n of pathNodes) {
    if (n.deg !== 1) continue;
    let best: GraphNode | null = null, bd = GAP_CLOSE;
    const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const lst = grid.get(`${cx + dx},${cy + dy}`);
        if (!lst) continue;
        for (const m of lst) {
          if (m === n) continue;
          const d = dist(n, m);
          if (d < bd && !edges.some((e) => (e.a === n.id && e.b === m.id) || (e.a === m.id && e.b === n.id))) { bd = d; best = m; }
        }
      }
    if (best && !sIndex.crossed(n, best, null)) { addEdge(n.id, best.id, 'outdoor', { connector: true }); gapsClosed++; }
  }

  // ---- doors (four tiers; see the handoff brief §5.4) ----
  const sectorOf = (b: Building, p: XY) =>
    Math.floor(((Math.atan2(p.y - b.c.y, p.x - b.c.x) + Math.PI) / (2 * Math.PI)) * DOOR_SECTORS) % DOOR_SECTORS;
  const doorsOf = new Map<string, Map<string, DoorSpec>>();
  buildings.forEach((b) => doorsOf.set(b.id, new Map()));
  const ringNodeOwner = new Map<number, Building>();
  for (const b of buildings) for (const v of b.ring) if (v.osm !== undefined) ringNodeOwner.set(v.osm, b);

  // 1. tagged doors on the outline, or within 3 m of it
  for (const idStr in idx.nodes) {
    const n = idx.nodes[idStr];
    const spec = doorSpec(n.tags);
    if (!spec) continue;
    const p = proj.xy(n.lat, n.lon);
    let b = ringNodeOwner.get(+idStr);
    if (!b) {
      let bd = 3;
      for (const c of buildings) {
        if (p.x < c.bbox.x0 - 3 || p.x > c.bbox.x1 + 3 || p.y < c.bbox.y0 - 3 || p.y > c.bbox.y1 + 3) continue;
        const d = distToRing(p, c.ring);
        if (d < bd) { bd = d; b = c; }
      }
    }
    if (!b || !b.campus) continue;
    if ('skip' in spec && spec.skip) { b.doorsSkipped.push(spec.skip); continue; }
    const nid = 'n' + idStr;
    addNode(nid, p, 'path', null);
    doorsOf.get(b.id)!.set(nid, { ...(spec as DoorSpec), side: compass8(bearingDeg(b.c, p)) });
    b.doorsTagged++;
  }

  // 2. corridors mapped inside, 3. sidewalks touching the wall (only when nothing is
  // tagged), 4. assumed doors on sides OSM says nothing about. A tagged door "covers"
  // its own sector and the two beside it, and when a building has any tagged entrance
  // the assumed ones cost more, so the router prefers what the map knows and only
  // invents a door when it saves a real detour.
  for (const b of buildings) {
    if (!b.campus) { b.doorCount = 0; continue; } // no hub, no doors, no cut-through
    const hub = addNode(b.id + ':hub', b.c, 'hub', b.id);
    const doors = doorsOf.get(b.id)!;
    const used = new Set([...doors.keys()].map((id) => sectorOf(b, nodes[id])));
    const cand: ({ n: GraphNode; d: number } | null)[] = new Array(DOOR_SECTORS).fill(null);
    for (const n of pathNodes) {
      if (n.x < b.bbox.x0 - DOOR_REACH || n.x > b.bbox.x1 + DOOR_REACH || n.y < b.bbox.y0 - DOOR_REACH || n.y > b.bbox.y1 + DOOR_REACH) continue;
      if (doors.has(n.id)) continue;
      if (pointInRing(n, b.ring)) {
        doors.set(n.id, { enter: true, exit: true, label: 'corridor', tagged: false, inside: true, stepFree: true, sec: 0 });
        continue;
      }
      const d = distToRing(n, b.ring);
      if (d > DOOR_REACH) continue;
      if (d <= DOOR_SNAP && b.doorsTagged === 0) {
        doors.set(n.id, {
          enter: true, exit: true, label: 'door', tagged: false, assumed: true, stepFree: true,
          sec: SEC.assumedDoor, side: compass8(bearingDeg(b.c, n)),
        });
        used.add(sectorOf(b, n));
        continue;
      }
      const s = sectorOf(b, n);
      if (!cand[s] || d < cand[s]!.d) cand[s] = { n, d };
    }
    const usable = [...doors.values()].filter((d) => d.tagged && d.enter && d.exit).length;
    const covered = new Set<number>();
    for (const s of used) { covered.add(s); covered.add((s + 1) % DOOR_SECTORS); covered.add((s + DOOR_SECTORS - 1) % DOOR_SECTORS); }
    const assumedSec = b.doorsTagged ? SEC.assumedDoor * ASSUMED_DOOR_PENALTY_FACTOR : SEC.assumedDoor;
    if (usable < 2)
      for (let s = 0; s < DOOR_SECTORS; s++) {
        if (covered.has(s) || !cand[s]) continue;
        const { n } = cand[s]!;
        const q = closestOnRing(n, b.ring);
        if (sIndex.crossed(n, q, null)) continue;
        const id = b.id + ':door' + s;
        addNode(id, q, 'door', b.id);
        addEdge(n.id, id, 'outdoor', { connector: true });
        doors.set(id, {
          enter: true, exit: true, label: 'door', tagged: false, assumed: true, stepFree: true,
          sec: assumedSec, side: compass8(bearingDeg(b.c, q)),
        });
      }
    b.doorsAssumed = [...doors.values()].filter((d) => d.assumed).length;
    b.doorCount = doors.size;

    const list = [...doors.entries()];
    for (const [id, spec] of list) {
      const dn = nodes[id];
      // Isolated doors get a connector to the nearest path node, never across a street.
      if (dn.deg === 0) {
        let best: GraphNode | null = null, bd = DOOR_CONNECT;
        for (const n of pathNodes) {
          const d = dist(n, dn);
          if (d < bd && n.id !== id && !sIndex.crossed(n, dn, null)) { bd = d; best = n; }
        }
        if (best) addEdge(id, best.id, 'outdoor', { connector: true });
      }
      // hub->door needs exit, door->hub needs enter. Hub edges carry the corridor
      // factor too, else door->hub->door undercuts door<->door pricing.
      const dir = spec.enter && spec.exit ? null : spec.exit ? 'ab' : 'ba';
      const he = addEdge(hub.id, id, 'indoor', { bld: b.id, doorSec: spec.sec, door: spec, dir, stepFree: spec.stepFree });
      he.len *= CORRIDOR_FACTOR;
    }
    // Door<->door edges price cut-throughs without the centroid detour.
    if (list.length <= 12)
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const [ia, sa] = list[i], [ib, sb] = list[j];
          const ab = sa.enter && sb.exit, ba = sb.enter && sa.exit;
          if (!ab && !ba) continue;
          const e = addEdge(ia, ib, 'indoor', {
            bld: b.id, doorSec: sa.sec + sb.sec, doorA: sa, doorB: sb,
            dir: ab && ba ? null : ab ? 'ab' : 'ba', stepFree: sa.stepFree && sb.stepFree,
          });
          e.len *= CORRIDOR_FACTOR;
        }
  }

  // ---- manual links (skywalks/subwalks OSM does not have) ----
  const byName = Object.fromEntries(buildings.map((b) => [b.name.toLowerCase(), b]));
  const find = (x: string | number) =>
    typeof x === 'number' ? buildings.find((b) => b.osmId === x) : byName[String(x).toLowerCase()];
  for (const l of overrides.manualLinks ?? []) {
    const A = find(l.a), B = find(l.b);
    // a building with no usable door has no hub to link to, and a hand-edited
    // file must never be able to crash the build
    if (!A || !B || A === B || !nodes[A.id + ':hub'] || !nodes[B.id + ':hub']) continue;
    addEdge(A.id + ':hub', B.id + ':hub', 'link', {
      linkKind: l.kind, bldA: A.id, bldB: B.id, verified: l.verified, note: l.note, manual: true,
    });
  }

  const adj: Record<string, Edge[]> = {};
  Object.keys(nodes).forEach((k) => (adj[k] = []));
  edges.forEach((e) => { adj[e.a].push(e); adj[e.b].push(e); });

  return {
    buildings, trees, nodes, edges, adj,
    byId: Object.fromEntries(buildings.map((b) => [b.id, b])),
    pathNodes, streets, doorsOf, gapsClosed, jaywalks,
    crossings: edges.filter((e) => e.crossing && e.crossing.type !== 'jaywalk').length,
  };
}

export function nearestPathNode(model: Model, p: XY): { node: GraphNode; d: number } | null {
  let best: GraphNode | null = null, bd = Infinity;
  for (const n of model.pathNodes) {
    const d = dist(n, p);
    if (d < bd) { bd = d; best = n; }
  }
  return best ? { node: best, d: bd } : null;
}
