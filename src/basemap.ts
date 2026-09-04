import type { Projection } from './geometry';
import { indexOsm, ringOf, type OsmIndex } from './osm/parse';
import type { OsmData, OsmTags, XY } from './types';

/**
 * Self-drawn basemap from the extract: ground polygons and street/walkway
 * lines, so no tile server is needed (tile.openstreetmap.org allows light use
 * only and may be blocked without notice).
 */
export type GroundKind = 'green' | 'wood' | 'water' | 'parking' | 'pitch' | 'sand' | 'dirt';
export interface GroundPoly { kind: GroundKind; ring: XY[] }
export interface BaseLine { klass: 'major' | 'minor' | 'service' | 'walk'; name: string | null; pts: XY[] }

const groundKind = (t: OsmTags): GroundKind | null => {
  if (t.building) return null;
  const lu = t.landuse, le = t.leisure, na = t.natural;
  if (na === 'water' || t.waterway === 'riverbank' || le === 'swimming_pool' || lu === 'basin' || lu === 'reservoir') return 'water';
  if (lu === 'forest' || na === 'wood' || na === 'scrub') return 'wood';
  if (le === 'pitch' || le === 'track' || le === 'stadium') return 'pitch';
  if (na === 'sand' || na === 'beach' || le === 'golf_course') return 'sand';
  if (t.amenity === 'parking') return 'parking';
  if (lu === 'construction' || lu === 'brownfield' || na === 'bare_rock') return 'dirt';
  if (lu === 'grass' || lu === 'meadow' || lu === 'village_green' || lu === 'recreation_ground' ||
    lu === 'cemetery' || le === 'park' || le === 'garden' || le === 'playground' || na === 'grassland') return 'green';
  return null;
};

const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link', 'tertiary_link']);
const MINOR = new Set(['residential', 'unclassified', 'living_street']);
const WALK = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway']);

export interface Basemap { ground: GroundPoly[]; lines: BaseLine[] }

export function extractBasemap(osm: OsmData, proj: Projection): Basemap {
  const idx: OsmIndex = indexOsm(osm);
  const ground: GroundPoly[] = [];
  const lines: BaseLine[] = [];
  for (const id in idx.ways) {
    const w = idx.ways[id];
    if (!w.tags) continue;
    const t = w.tags;
    const kind = groundKind(t);
    if (kind && w.nodes[0] === w.nodes[w.nodes.length - 1]) {
      const ring = ringOf(w, idx, proj);
      if (ring.length >= 3) ground.push({ kind, ring });
      continue;
    }
    const hw = t.highway;
    if (!hw) continue;
    const pts = ringOf(w, idx, proj);
    if (pts.length < 2) continue;
    if (MAJOR.has(hw)) lines.push({ klass: 'major', name: t.name || null, pts });
    else if (MINOR.has(hw)) lines.push({ klass: 'minor', name: t.name || null, pts });
    else if (hw === 'service') lines.push({ klass: 'service', name: t.name || null, pts });
    else if (WALK.has(hw)) lines.push({ klass: 'walk', name: t.name || null, pts });
  }
  return { ground, lines };
}
