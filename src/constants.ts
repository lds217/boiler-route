/** Study area (south, west, north, east). Widen freely; everything scales.
 *  South edge sits just past Williams Street (~40.4185). */
export const BBOX: [number, number, number, number] = [40.4175, -86.918, 40.4302, -86.9105];

export const WALK_SPEED = 1.35; // m/s, typical campus pace
export const INDOOR_FACTOR = 1.2; // doors, people, stairs
export const CORRIDOR_FACTOR = 1.4; // corridors bend; straight-line indoor distance is optimistic
export const ROAD_FACTOR = 1.15; // walking along a street with no separately mapped sidewalk
export const STEPS_FACTOR = 1.3;
export const MAX_SHADOW = 300; // m: caps low-sun shadow rays
export const DOOR_SNAP = 8; // m: sidewalk this close to the wall counts as a door (untagged buildings)
export const DOOR_REACH = 35; // m: how far to look for a path node when assuming a door
export const DOOR_SECTORS = 8;
export const GAP_CLOSE = 4; // m: dangling path ends this close to another path get joined
export const DOOR_CONNECT = 30; // m: max connector from an isolated door to the path network
export const PIN_CONNECT = 60; // m: beyond this, "no mapped path near"
export const DEFAULT_HOURS: [number, number] = [7, 22];
export const DEFAULT_BUILDING_HEIGHT = 12; // m
export const LEVEL_HEIGHT = 3.5; // m per building:level
export const DEFAULT_TREE_HEIGHT = 10; // m
export const DEFAULT_TREE_CROWN_RADIUS = 6; // m

/** Seconds added for doors and crossings. Door values prefer what OSM knows. */
export const SEC = {
  mainDoor: 5,
  door: 8,
  serviceDoor: 25,
  assumedDoor: 15,
  signalCrossing: 20,
  markedCrossing: 6,
  plainCrossing: 10,
  jaywalk: 45,
} as const;

/** When a building has any tagged entrance, assumed doors cost more so the map's knowledge wins. */
export const ASSUMED_DOOR_PENALTY_FACTOR = 2.5;

/**
 * Streets a pedestrian must not cross except at a crossing. Everything else
 * (service roads, parking aisles, living streets) is treated as shared space.
 */
export const STREETS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

export const WALKWAYS = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'corridor', 'service', 'living_street',
  'cycleway', 'track', 'bridleway', 'crossing',
]);

/** Streets never walked along even if they claim to be walkable. */
export const NEVER_WALK = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const FETCH_TIMEOUT = 45_000;

export const overpassQuery = (bbox: [number, number, number, number]): string => `[out:json][timeout:40];
(
  way["building"](${bbox});
  relation["building"](${bbox});
  way["highway"](${bbox});
  node["natural"="tree"](${bbox});
  node["entrance"](${bbox});
  node["door"](${bbox});
  node["indoor"="door"](${bbox});
  node["highway"="crossing"](${bbox});
  way["landuse"](${bbox});
  way["leisure"](${bbox});
  way["natural"](${bbox});
  way["amenity"="parking"](${bbox});
  way["waterway"](${bbox});
  way["amenity"="university"](${bbox});
  relation["amenity"="university"](${bbox});
);
out body;
>;
out skel qt;`;
