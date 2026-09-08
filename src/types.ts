export interface XY { x: number; y: number }
export interface BBoxXY { x0: number; y0: number; x1: number; y1: number }
export type LatLonBBox = [number, number, number, number]; // south, west, north, east

export type OsmTags = Record<string, string>;
export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: OsmTags }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: OsmTags }
export interface OsmRelation {
  type: 'relation'; id: number; tags?: OsmTags;
  members?: { type: string; ref: number; role: string }[];
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;
export interface OsmData { elements: OsmElement[]; _source?: string; _seconds?: string; _fetched?: string }

export interface RingPoint extends XY { osm?: number }

export interface Building {
  id: string; // 'b' + osmId
  osmId: number;
  name: string;
  named: boolean;
  abbr: string;
  ring: RingPoint[];
  bbox: BBoxXY;
  c: XY; // centroid
  height: number; // m
  heightTagged: boolean;
  heightSource: 'lidar' | 'osm' | 'assumed';
  /** Inside the university grounds: routable indoors, searchable, labeled.
   *  Off-campus buildings only cast shadows and draw as basemap shapes. */
  campus: boolean;
  hours: [number, number]; // decimal hours [open, close)
  hoursTagged: boolean;
  /** From campus-overrides.json; beats OSM opening_hours. */
  hoursOverride?: [number, number];
  tags: OsmTags;
  doorsTagged: number;
  doorsAssumed: number;
  doorsSkipped: string[];
  doorCount: number;
  /** Assumed indoor temperature, °C; null = unconditioned (indoor feels like outdoor air). */
  indoorC: number | null;
}

export interface Tree {
  id: string;
  c: XY;
  r: number; // crown radius, m
  height: number;
  ring: XY[];
  bbox: BBoxXY;
}

export type NodeKind = 'path' | 'hub' | 'door';
export interface GraphNode extends XY {
  id: string;
  kind: NodeKind;
  bld: string | null;
  deg: number;
}

export type EdgeKind = 'outdoor' | 'indoor' | 'link';
export type CrossingType = 'signal' | 'marked' | 'plain' | 'jaywalk';
export interface Crossing { type: CrossingType; street?: string; klass?: string }

export interface DoorSpec {
  enter: boolean;
  exit: boolean;
  main?: boolean;
  service?: boolean;
  label: string;
  tagged: boolean;
  assumed?: boolean;
  inside?: boolean;
  stepFree: boolean;
  sec: number;
  side?: string; // compass octant from centroid
}

export type LinkKind = 'skywalk' | 'subwalk' | 'corridor';

export interface Edge {
  id: number;
  a: string;
  b: string;
  kind: EdgeKind;
  len: number; // m (indoor lengths already include the corridor factor)
  // outdoor
  name?: string | null;
  road?: boolean;
  steps?: boolean;
  covered?: boolean;
  connector?: boolean;
  /** OSM lit tag: true=yes, false=no, null/undefined=not mapped. */
  lit?: boolean | null;
  crossing?: Crossing | null;
  osmWay?: number;
  // indoor
  bld?: string | null;
  doorSec?: number;
  door?: DoorSpec;
  doorA?: DoorSpec;
  doorB?: DoorSpec;
  dir?: 'ab' | 'ba' | null;
  stepFree?: boolean;
  // link
  linkKind?: LinkKind | null;
  bldA?: string;
  bldB?: string;
  verified?: boolean;
  note?: string;
  manual?: boolean;
}

export interface StreetSeg {
  a: XY; b: XY;
  na: number; nb: number; // OSM node ids
  name: string;
  klass: string; // highway value, for crossing risk
  osmWay: number;
}

export interface Model {
  buildings: Building[];
  trees: Tree[];
  nodes: Record<string, GraphNode>;
  edges: Edge[];
  adj: Record<string, Edge[]>;
  byId: Record<string, Building>;
  pathNodes: GraphNode[];
  streets: StreetSeg[];
  doorsOf: Map<string, Map<string, DoorSpec>>;
  gapsClosed: number;
  jaywalks: number;
  crossings: number;
}

export interface ManualLink {
  a: string | number; // OSM way id or exact building name
  b: string | number;
  kind: 'skywalk' | 'subwalk';
  verified: boolean;
  note?: string;
}

export interface BuildingOverride {
  /** Building is air conditioned / heated; false means indoor feels like outdoor air temp. */
  conditioned?: boolean;
  indoorC?: number;
  /** Real hours, decimal [open, close), beats OSM and the default. */
  hours?: [number, number];
}

export interface CampusOverrides {
  manualLinks: ManualLink[];
  /** Keyed by building name or OSM id (as string). */
  buildings: Record<string, BuildingOverride>;
}

/** Output of scripts/heights.py: NDHM lidar heights and canopy circles. */
export interface CanopyCircle { lat: number; lon: number; r: number; h: number }
export interface HeightsData {
  _generated?: string;
  _source?: string;
  buildings: Record<string, number>; // OSM id → height in m (90th percentile NDHM)
  canopy: CanopyCircle[];
  /** One box per lidar tile; outside all of them OSM trees are kept. */
  coverage?: { south: number; west: number; north: number; east: number }[];
}

export type Place =
  | { kind: 'building'; id: string; label: string }
  | { kind: 'point'; nodeId: string; lat: number; lon: number; label: string };

export type Wind = 'calm' | 'breezy' | 'windy';

export interface RouteContext {
  w: number; // comfort slider 0..1
  sunFrac: Float32Array;
  feels: Float32Array;
  stress: Float32Array;
  /** Per-building indoor stress (index into by building id); default applies otherwise. */
  indoorStress: Record<string, number>;
  defaultIndoorStress: number;
  open: Record<string, boolean>;
  hot: boolean;
  tC: number;
  stepFree: boolean;
  noJaywalk: boolean;
  mins: number;
  /** Sun below the horizon: lighting and crossing risk go up. */
  night: boolean;
  /** At or below freezing: outdoor stairs are slower. */
  icy: boolean;
  precipMm: number;
  /** Indoor and link edges are barred except for the buildings in throughOk. */
  noCutThrough: boolean;
  throughOk: Set<string>;
}

export interface RouteSummary {
  len: number;
  time: number;
  outdoorLen: number;
  sunLen: number;
  shadeLen: number;
  indoorLen: number;
  via: string[];
  unverified: boolean;
  worst: number | null;
  crossings: number;
  jaywalks: number;
  assumedDoors: number;
  /** Outdoor metres at night with no mapped lighting. */
  unlitLen: number;
  /** Crossings of a primary/secondary or bigger road. */
  majorCrossings: number;
}

export type Maneuver = 'start' | 'straight' | 'left' | 'right' | 'uturn' | 'cross' | 'exit' | 'arrive' | 'through' | 'link';

export interface DirectionStep {
  icon: 'su' | 'sh' | 'mx' | 'in';
  /** What the walker physically does, for the turn arrow in the UI. */
  maneuver: Maneuver;
  text: string;
  sub: string;
  m: number;
  at: XY;
  warn?: boolean;
}

export interface SunPosition { alt: number; bearing: number }
