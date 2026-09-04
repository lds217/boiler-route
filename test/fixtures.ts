/**
 * Synthetic Overpass-shaped fixtures (§15 of the handoff brief).
 * Coordinates are given in local metres and converted to lat/lon with the same
 * projection the app uses, so distances survive the round trip.
 */
import { BBOX } from '../src/constants';
import { createProjection, type Projection } from '../src/geometry';
import { buildModel, type BuildOptions } from '../src/graph/build';
import type { Model, OsmData, OsmElement, OsmTags } from '../src/types';

export const proj: Projection = createProjection(BBOX);

export class Fx {
  elements: OsmElement[] = [];
  private nextId = 1000;
  private nodeIds = new Map<string, number>();

  /** Node at local metres (x, y). Nodes at identical coordinates are shared. */
  node(x: number, y: number, tags?: OsmTags): number {
    const key = `${x},${y}`;
    let id = this.nodeIds.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.nodeIds.set(key, id);
      const [lat, lon] = proj.ll({ x, y });
      this.elements.push({ type: 'node', id, lat, lon, ...(tags ? { tags } : {}) });
    } else if (tags) {
      const el = this.elements.find((e) => e.type === 'node' && e.id === id) as { tags?: OsmTags };
      el.tags = { ...el.tags, ...tags };
    }
    return id;
  }

  way(coords: [number, number][], tags: OsmTags, nodeTags?: (OsmTags | undefined)[]): number {
    const id = this.nextId++;
    const nodes = coords.map(([x, y], i) => this.node(x, y, nodeTags?.[i]));
    this.elements.push({ type: 'way', id, nodes, tags });
    return id;
  }

  /** Closed building ring from an explicit perimeter (door nodes included in order). */
  building(perimeter: [number, number][], tags: OsmTags, nodeTags?: (OsmTags | undefined)[]): number {
    const id = this.nextId++;
    const nodes = perimeter.map(([x, y], i) => this.node(x, y, nodeTags?.[i]));
    nodes.push(nodes[0]); // close the ring
    this.elements.push({ type: 'way', id, nodes, tags: { building: 'yes', ...tags } });
    return id;
  }

  osm(): OsmData { return { elements: this.elements }; }

  model(opts: Partial<BuildOptions> = {}): Model {
    return buildModel(this.osm(), proj, { weekday: 3, ...opts });
  }
}

/**
 * fake2: three 80×60 m buildings in a row, sidewalks 14 m north and south,
 * vertical connectors through the gaps. No streets. All doors assumed.
 * The north sidewalk has a 3 m break near x=-120 to exercise gap closing.
 */
export function fake2(): Fx {
  const f = new Fx();
  f.building([[-140, -30], [-100, -30], [-60, -30], [-60, 0], [-60, 30], [-100, 30], [-140, 30], [-140, 0]],
    { name: 'One Hall', short_name: 'ONE' });
  f.building([[-40, -30], [0, -30], [40, -30], [40, 0], [40, 30], [0, 30], [-40, 30], [-40, 0]],
    { name: 'Two Hall', short_name: 'TWO' });
  f.building([[60, -30], [100, -30], [140, -30], [140, 0], [140, 30], [100, 30], [60, 30], [60, 0]],
    { name: 'Three Hall', short_name: 'THREE' });
  // north sidewalk, split with a 3 m gap at x ≈ -120 (dangling ends → gap closer)
  f.way([[-160, 44], [-122, 44]], { highway: 'footway', name: 'North Walk' });
  f.way([[-119, 44], [-100, 44], [-50, 44], [0, 44], [50, 44], [100, 44], [160, 44]], { highway: 'footway', name: 'North Walk' });
  // south sidewalk
  f.way([[-160, -44], [-100, -44], [-50, -44], [0, -44], [50, -44], [100, -44], [160, -44]], { highway: 'footway', name: 'South Walk' });
  // vertical connectors through the gaps, with midpoint nodes for door candidates
  f.way([[-50, 44], [-50, 0], [-50, -44]], { highway: 'footway' });
  f.way([[50, 44], [50, 0], [50, -44]], { highway: 'footway' });
  // west and east end connectors so the sidewalks form a loop
  f.way([[-160, 44], [-160, 0], [-160, -44]], { highway: 'footway' });
  f.way([[160, 44], [160, 0], [160, -44]], { highway: 'footway' });
  return f;
}

/**
 * fake3: adds a N–S residential street between buildings 2 and 3 with a signal
 * crossing on the south sidewalk, a jaywalking north sidewalk, tagged doors on
 * Alpha and Beta, an untagged Gamma, and a grass polygon.
 */
export function fake3(): Fx {
  const f = new Fx();
  // Alpha: main entrance E, emergency W, exit-only S
  f.building(
    [[-140, -30], [-100, -30], [-60, -30], [-60, 0], [-60, 30], [-100, 30], [-140, 30], [-140, 0]],
    { name: 'Alpha Hall', short_name: 'ALPH' },
    [undefined, { entrance: 'exit' }, undefined, { entrance: 'main' }, undefined, undefined, undefined, { entrance: 'emergency' }],
  );
  // Beta: main entrance W, plain entrance E, opening hours
  f.building(
    [[-40, -30], [0, -30], [40, -30], [40, 0], [40, 30], [0, 30], [-40, 30], [-40, 0]],
    { name: 'Beta Hall', short_name: 'BETA', opening_hours: 'Mo-Fr 07:00-22:00; Sa-Su 09:00-17:00' },
    [undefined, undefined, undefined, { entrance: 'yes' }, undefined, undefined, undefined, { entrance: 'main' }],
  );
  // Gamma: no tagged doors
  f.building([[60, -30], [100, -30], [140, -30], [140, 0], [140, 30], [100, 30], [60, 30], [60, 0]],
    { name: 'Gamma Hall', short_name: 'GAMM' });
  // north sidewalk crosses the street with NO shared node → data-level jaywalk
  f.way([[-160, 44], [-100, 44], [-50, 44], [0, 44], [44, 44], [100, 44], [160, 44]], { highway: 'footway', name: 'North Walk' });
  // south sidewalk, west of the street
  f.way([[-160, -44], [-100, -44], [-50, -44], [0, -44], [44, -44]], { highway: 'footway', name: 'South Walk' });
  // signal crossing over the street (shares the street's crossing node)
  f.way([[44, -44], [50, -44], [56, -44]], { highway: 'footway', footway: 'crossing' },
    [undefined, { highway: 'crossing', crossing: 'traffic_signals' }, undefined]);
  // south sidewalk, east of the street
  f.way([[56, -44], [100, -44], [160, -44]], { highway: 'footway', name: 'South Walk' });
  // the street itself; the middle node is the signal crossing node
  f.way([[50, 80], [50, -44], [50, -80]], { highway: 'residential', name: 'Test Street' });
  // vertical connectors: Alpha–Beta gap, and between Beta and the street
  f.way([[-50, 44], [-50, 0], [-50, -44]], { highway: 'footway' });
  f.way([[44, 44], [44, 0], [44, -44]], { highway: 'footway' });
  // stub east of the street toward Gamma's west wall (4 m from the wall → touching door)
  f.way([[56, -44], [56, 0]], { highway: 'footway' });
  // west and east end connectors so the sidewalks form a loop
  f.way([[-160, 44], [-160, 0], [-160, -44]], { highway: 'footway' });
  f.way([[160, 44], [160, 0], [160, -44]], { highway: 'footway' });
  // ground-cover polygon the graph must ignore
  f.way([[-160, 60], [160, 60], [160, 80], [-160, 80], [-160, 60]], { landuse: 'grass' });
  return f;
}
