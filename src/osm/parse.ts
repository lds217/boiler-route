import {
  DEFAULT_BUILDING_HEIGHT, DEFAULT_HOURS, DEFAULT_TREE_CROWN_RADIUS, DEFAULT_TREE_HEIGHT,
  LEVEL_HEIGHT, NEVER_CAMPUS_BUILDING, SEC,
} from '../constants';
import { bboxOf, centroid, pointInRing, type Projection } from '../geometry';
import { INDOOR_C } from '../comfort';
import { parseHours } from '../hours';
import type {
  Building, BuildingOverride, DoorSpec, OsmData, OsmNode, OsmRelation, OsmTags, OsmWay, RingPoint, Tree,
} from '../types';

export interface OsmIndex {
  nodes: Record<number, OsmNode>;
  ways: Record<number, OsmWay>;
  relations: OsmRelation[];
}

export function indexOsm(osm: OsmData): OsmIndex {
  const nodes: Record<number, OsmNode> = {}, ways: Record<number, OsmWay> = {}, relations: OsmRelation[] = [];
  for (const el of osm.elements) {
    if (el.type === 'node') nodes[el.id] = el;
    else if (el.type === 'way') ways[el.id] = el;
    else relations.push(el);
  }
  return { nodes, ways, relations };
}

export const ringOf = (way: OsmWay, idx: OsmIndex, proj: Projection): RingPoint[] =>
  way.nodes.map((id) => idx.nodes[id]).filter(Boolean).map((n) => ({ ...proj.xy(n.lat, n.lon), osm: n.id }));

/** Abbreviation from initials when OSM has no short_name/ref. */
export function initials(name: string): string {
  const skip = new Set(['of', 'and', 'the', 'for', 'hall', 'building', 'center', 'centre', 'laboratory', 'lab']);
  const w = name.replace(/[()]/g, '').split(/\s+/).filter((x) => !skip.has(x.toLowerCase()));
  return (w.length >= 2 ? w.map((x) => x[0]).join('') : name.slice(0, 4)).toUpperCase().slice(0, 5);
}

/**
 * University grounds (amenity=university ways and multipolygon relations).
 * Outer ways are stitched into closed rings; a building whose centroid falls
 * inside any ring is a campus building.
 */
export function extractCampusPolys(idx: OsmIndex, proj: Projection): RingPoint[][] {
  const polys: RingPoint[][] = [];
  for (const id in idx.ways) {
    const w = idx.ways[id];
    if (w.tags?.amenity === 'university' && w.nodes[0] === w.nodes[w.nodes.length - 1]) {
      const r = ringOf(w, idx, proj);
      if (r.length >= 4) polys.push(r);
    }
  }
  for (const rel of idx.relations) {
    if (rel.tags?.amenity !== 'university') continue;
    let outers = (rel.members || [])
      .filter((m) => m.type === 'way' && m.role !== 'inner' && idx.ways[m.ref])
      .map((m) => ringOf(idx.ways[m.ref], idx, proj))
      .filter((r) => r.length >= 2);
    let guard = 200;
    while (outers.length && guard--) {
      const ring = stitchRings(outers); // consumes matching ways from `outers`
      if (ring.length >= 4) polys.push(ring);
    }
  }
  return polys;
}

/** Join a relation's outer ways into one ring by matching endpoints. */
export function stitchRings(rings: RingPoint[][]): RingPoint[] {
  let out = rings.shift()!, guard = 50;
  while (rings.length && guard--) {
    const tail = out[out.length - 1].osm;
    let k = rings.findIndex((r) => r[0].osm === tail), rev = false;
    if (k < 0) { k = rings.findIndex((r) => r[r.length - 1].osm === tail); rev = true; }
    if (k < 0) break;
    let r = rings.splice(k, 1)[0];
    if (rev) r = r.slice().reverse();
    out = out.concat(r.slice(1));
  }
  return out;
}

function overrideFor(overrides: Record<string, BuildingOverride>, osmId: number, name: string | null): BuildingOverride | undefined {
  return overrides[String(osmId)] ?? (name ? overrides[name] : undefined);
}

export function extractBuildings(
  idx: OsmIndex, proj: Projection, weekday: number,
  overrides: Record<string, BuildingOverride> = {},
  lidarHeights: Record<string, number> = {},
  campusPolys: RingPoint[][] = [],
): Building[] {
  const buildings: Building[] = [];
  // With no campus polygon in the data, everything is campus (synthetic fixtures,
  // or an extract from before amenity=university was fetched).
  const onCampus = (c: { x: number; y: number }, tags: OsmTags): boolean => {
    if (tags.building === 'university' || /purdue/i.test(tags.operator || '')) return true;
    // a garage or a private house inside the grounds is still not somewhere you route through
    if (NEVER_CAMPUS_BUILDING.has(tags.building ?? '')) return false;
    if (!campusPolys.length) return true;
    return campusPolys.some((ring) => pointInRing(c, ring));
  };
  const add = (id: number, tags: OsmTags, ring: RingPoint[] | undefined) => {
    if (!ring || ring.length < 4) return;
    if (ring[0].osm === ring[ring.length - 1].osm) ring = ring.slice(0, -1);
    const name = tags.name || tags['addr:housename'] || tags.description || null;
    const abbr = tags.short_name || tags.ref || (name ? initials(name) : '#' + id);
    const levels = parseFloat(tags['building:levels']);
    const lidar = lidarHeights[String(id)];
    const height = lidar || parseFloat(tags.height) || (levels ? levels * LEVEL_HEIGHT : DEFAULT_BUILDING_HEIGHT);
    const heightSource = lidar ? 'lidar' as const
      : tags.height || levels ? 'osm' as const : 'assumed' as const;
    const ov = overrideFor(overrides, id, name);
    const hrs = ov?.hours ?? parseHours(tags.opening_hours, weekday);
    const indoorC = ov?.conditioned === false ? null : ov?.indoorC ?? INDOOR_C;
    const c = centroid(ring);
    buildings.push({
      id: 'b' + id, osmId: id, name: name || `Unnamed building ${id}`, named: !!name, abbr,
      ring, bbox: bboxOf(ring), c, campus: onCampus(c, tags), height,
      heightTagged: heightSource !== 'assumed', heightSource,
      hours: hrs || DEFAULT_HOURS, hoursTagged: !!hrs, hoursOverride: ov?.hours, tags,
      doorsTagged: 0, doorsAssumed: 0, doorsSkipped: [], doorCount: 0, indoorC,
    });
  };
  for (const id in idx.ways) {
    const w = idx.ways[id];
    if (w.tags && w.tags.building && w.tags.building !== 'no') add(+id, w.tags, ringOf(w, idx, proj));
  }
  for (const rel of idx.relations) {
    if (!rel.tags || !rel.tags.building) continue;
    const outers = (rel.members || [])
      .filter((m) => m.type === 'way' && m.role !== 'inner' && idx.ways[m.ref])
      .map((m) => idx.ways[m.ref]);
    if (!outers.length) continue;
    const closed = outers.find((w) => w.nodes[0] === w.nodes[w.nodes.length - 1]);
    add(rel.id, rel.tags, closed ? ringOf(closed, idx, proj) : stitchRings(outers.map((w) => ringOf(w, idx, proj))));
  }
  return buildings;
}

export function extractTrees(idx: OsmIndex, proj: Projection): Tree[] {
  const trees: Tree[] = [];
  const circleRing = (c: { x: number; y: number }, r: number) => {
    const o = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 2 * Math.PI;
      o.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
    return o;
  };
  for (const id in idx.nodes) {
    const n = idx.nodes[id];
    if (n.tags && n.tags.natural === 'tree') {
      const p = proj.xy(n.lat, n.lon);
      const r = (parseFloat(n.tags.diameter_crown) || DEFAULT_TREE_CROWN_RADIUS * 2) / 2;
      trees.push({
        id: 't' + id, c: p, r,
        height: parseFloat(n.tags.height) || DEFAULT_TREE_HEIGHT,
        ring: circleRing(p, r),
        bbox: { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r },
      });
    }
  }
  return trees;
}

/** What an OSM node's tags say about a door. Returns null if the node is not a door. */
export function doorSpec(t: OsmTags | undefined): (DoorSpec & { skip?: undefined }) | { skip: string } | null {
  if (!t) return null;
  const ent = t.entrance, hasDoor = t.door !== undefined, ind = t.indoor === 'door';
  if (!ent && !hasDoor && !ind) return null;
  if (ent === 'no') return { skip: 'sealed' };
  if (ent === 'emergency' || t.exit === 'emergency') return { skip: 'emergency exit' };
  if (['private', 'no', 'delivery', 'customers'].includes(t.access) || t.locked === 'yes') return { skip: 'private' };
  const exitOnly = ent === 'exit' || t.exit === 'only', enterOnly = ent === 'entrance';
  const main = ent === 'main', service = ['service', 'garage', 'staircase'].includes(ent);
  const label = main ? 'main entrance'
    : ent === 'secondary' ? 'secondary entrance'
    : service ? 'service door'
    : exitOnly ? 'exit'
    : enterOnly ? 'entrance'
    : t.door === 'no' ? 'opening' : 'door';
  return {
    enter: !exitOnly, exit: !enterOnly, main, service, label, tagged: true,
    stepFree: t.wheelchair !== 'no',
    sec: main ? SEC.mainDoor : service ? SEC.serviceDoor : t.door === 'no' ? 0 : SEC.door,
  };
}
