# Boiler Route

Weather-aware pedestrian routing for Purdue's West Lafayette campus. Routes
prefer being inside buildings when it is hot or cold, and prefer shade when it
is hot, at a cost in walking time the user controls.

This is the robust rebuild of the single-file reference implementation
(`boiler-route (5).html`), following the handoff brief: TypeScript modules,
Vite, Vitest with the §15 synthetic fixtures as real tests, a data-refresh
pipeline, PWA offline support, and GitHub Actions for test + weekly data
refresh + Pages deploy.

## Quick start

```sh
npm install
npm run update-data   # fetch the OSM extract once (CI does this weekly)
npm run dev           # app on http://localhost:5173
npm test              # 62 tests incl. the fake2/fake3 fixtures and a real-data smoke test
npm run build         # typecheck + production build to dist/
```

## Layout

```
src/
  constants.ts     study-area BBOX, all tuning constants (§12 of the brief), Overpass query
  types.ts         the full data model (§4)
  geometry.ts      local projection, rings, intersections, hulls, bearings
  hours.ts         opening_hours parser + per-weekday open computation
  sun.ts           low-precision solar position
  comfort.ts       UTCI-band stress + feels-like model (§7, sources inline)
  shade.ts         per-edge sun fraction + drawable shadow hulls (§6)
  osm/parse.ts     element indexing, buildings (incl. relations), trees, door tags
  graph/build.ts   walkable graph: streets, crossings, jaywalks, gap closing,
                   the four-tier door model, manual links (§5)
  routing.ts       Dijkstra over the directed edge view, edge costs, summaries (§8)
  directions.ts    turn-by-turn generator (§9)
  diagnose.ts      "no route found" explanations
  weather.ts       Open-Meteo fetch + hourly lookup
  overpass.ts      bundled-data-first loading, Overpass fallback with mirrors
  basemap.ts       self-drawn basemap (ground polygons + street/walk lines)
  ui/main.ts       the app: search card, route cards, conditions, Leaflet map
test/
  fixtures.ts      fake2 + fake3 synthetic Overpass fixtures (§15)
  *.test.ts        graph, routing, directions, units, real-data smoke tests
scripts/update-data.mjs   Overpass → public/boiler-route-data.json (CI weekly)
campus-overrides.json     hand-maintained: manual skywalk/subwalk links,
                          per-building conditioned/hours overrides (kept out of
                          the OSM data file for ODbL cleanliness)
```

## How routing works

### Route cost: the comfort bias

The search is plain Dijkstra (`src/routing.ts`); only the edge cost changes.
Each update runs it twice: **fast** with comfort weight `w = 0`, and **comfy**
with `w` = comfort slider / 100.

Outdoor edge:

```
cost = walkTime × (1 + w × stress) × litFactor + crossRisk
```

- **walkTime**: length ÷ 1.35 m/s. Stairs ×1.3, and uncovered stairs a further
  ×1.8 when icy (≤ 1 °C). Crossing delay is added in seconds (signal 20 s,
  marked 6 s, plain 10 s, jaywalk 45 s).
- **stress** (`src/comfort.ts`): feels-like temperature from air temperature,
  sun (see below), wind and cloud, mapped through a piecewise-linear curve on
  the UTCI stress bands: 0 between 18 and 26 °C, rising to 8 at −40 °C or
  55 °C. Rain adds up to 2 more on uncovered edges.
- **litFactor and crossRisk**: the safety layer, applied at every comfort
  setting including Fastest. After dark, lit paths cost ×1, unknown lighting
  ×1.25, unlit ×1.7. Crossing a street adds seconds-equivalent by road class
  (service 1 s, residential 4 s, primary 50 s, motorway 600 s), ×3 for a
  jaywalk and ×1.4 at night.

Indoor edge: `cost = walkTime × (1 + w × indoorStress)`. Conditioned buildings
are 22 °C, which is zero stress, so indoors costs only its time. Unconditioned
buildings use the outdoor air temperature.

An edge costs ∞ (is skipped) when it goes the wrong way through a one-way door,
has steps while step-free is on, is a jaywalk while "no jaywalk" is on, is in a
closed building, cuts through a building other than the start or end while
that is turned off, or is a tunnel or skywalk in non-severe weather.

Example, 30 °C with the sun at 60°:

| | Time | Feels like | Stress | Cost at w = 0 | Cost at w = 0.5 |
|---|---|---|---|---|---|
| 100 m sunny sidewalk | 74 s | 38.7 °C | 3.17 | **74** | 191 |
| 130 m shaded path | 96 s | 30 °C | 1.0 | 96 | **144** |

The two break even near w ≈ 0.16; above that the shaded path wins. The bias
only scales or adds to non-negative costs, so Dijkstra still returns the true
cheapest path.

### Sun position over time

The date picker and time slider become a `Date`, which `sunPosition`
(`src/sun.ts`) turns into altitude and bearing with the standard low-precision
formula (the same maths as suncalc):

| Step | Meaning |
|---|---|
| `d = ms/86400000 − 0.5 + 2440588 − 2451545` | days since J2000 (1 Jan 2000, 12:00) |
| `M = 357.53° + 0.9856°·d` | mean anomaly: Earth's place on a circular orbit |
| `C = 1.9148°·sin M + …` | equation of center: correction for the elliptical orbit (up to ±1.9°) |
| `L = M + C + 102.94° + 180°` | ecliptic longitude of the sun as seen from Earth |
| `dec = asin(sin 23.44° · sin L)` | declination: carries the **season** (±23.44°) |
| `H = 280.16° + 360.9856°·d + lon − ra` | hour angle: carries the **time of day**, 0 at solar noon |
| `alt = asin(sin φ sin δ + cos φ cos δ cos H)` | altitude above the horizon |
| `atan2(sin H, cos H sin φ − tan δ cos φ) + π` | compass bearing, 0 = north |

Sample output for campus (φ ≈ 40.4°), local time:

| Time | Altitude | Bearing | Shadow of a 12 m building | Sun heat added |
|---|---|---|---|---|
| Jun 21, 08:00 | 16.8° | 73° (ENE) | 40 m | +2.9 °C |
| Jun 21, 13:40 | 72.9° | 172° (S) | 3.7 m | +9.6 °C |
| Jun 21, 18:00 | 35.4° | 272° (W) | 17 m | +5.8 °C |
| Nov 22, 08:00 | 2.2° | 119° (ESE) | 307 m, capped to 300 | +0.4 °C |
| Nov 22, 12:30 | 29.4° | 179° (S) | 21 m | +4.9 °C |
| Nov 22, 16:00 | 12.8° | 229° (SW) | 53 m | +2.2 °C |

Solar noon on campus is about 12:35 in winter and 13:50 in summer, not 12:00.
Campus is about 12° west of the Eastern time zone's reference meridian, so the
sun runs about 48 minutes late, and daylight saving and the equation of time
shift it further.

### From sun to shade to cost

`computeShade` (`src/shade.ts`):

- At night (altitude ≤ 0) nothing is in sun, and the `night` flag turns on the
  lighting and crossing penalties above.
- Each building or tree casts a shadow `height / tan(altitude)` long, capped
  at 300 m (`MAX_SHADOW`), opposite the sun's bearing.
- Each outdoor edge is sampled at 10, 30, 50, 70 and 90 % of its length. A
  sample is shaded if a ray toward the sun, as long as the caster's shadow,
  enters a building or tree outline. `sunFrac` = sunny samples ÷ 5; covered
  edges are always 0.
- Casters are bucketed into 64 m grid cells over the ground they can shade, so
  each sample tests only nearby casters.
- Results are cached by date and minute, so moving the comfort slider never
  recomputes shade.

`feelsLike` then adds `10 °C × sin(altitude) × sunFrac × (1 − 0.75 × cloud%)`
before stress is computed. The same sidewalk therefore costs more at 13:40 in
June (+9.6 °C) than at 08:00 (+2.9 °C), and the best route changes with the
clock.

### Limits of the sun model

- No atmospheric refraction: near the horizon the real sun sits about 0.5°
  higher, so "night" starts a few minutes before the visible sunset.
- The time slider is read in the **browser's** time zone, not campus time
  (America/Indiana/Indianapolis). On a device set to another zone, the sun and
  shadows are off by the difference.

## Data and policies

- **OpenStreetMap** (ODbL): buildings, paths, entrances, trees, ground cover.
  Attribution stays visible regardless of basemap because the vectors are OSM
  too. End users load the bundled `public/boiler-route-data.json`; Overpass is
  only a fallback, with three mirrors, 45 s timeouts and visible failure logs.
  The weekly `update-data` workflow keeps the bundle fresh (set the
  `BOILER_ROUTE_CONTACT` repo variable to a contactable URL/email for the
  User-Agent).
- **Open-Meteo**: live temperature/wind/cloud, no key, CORS enabled.
- **Basemap**: built-in by default (drawn from the extract — no tile server);
  OSM tiles optional and light-use only.

## Deliberate deviations from the brief's §16

- **Leaflet, not MapLibre GL**: the basemap is self-drawn from the extract, so
  vector-tile rendering buys nothing yet; Leaflet's canvas renderer is what the
  reference proved out. The map code lives behind `ui/main.ts` and can be
  swapped without touching the library.
- **The client still builds the graph from the raw extract** (as the reference
  did). Precomputing the cleaned graph + shade tables in CI is the next step
  once NDHM heights land; the module boundaries (`osm/parse` → `graph/build`)
  are already cut so the build step can move server-side unchanged.

## Lidar heights and canopy

`scripts/heights.py` (run with `npm run heights`, needs [uv](https://docs.astral.sh/uv/))
reads Purdue 2018 NDHM lidar tiles (`*_ndhm.tif` in the repo root, from the
Purdue Geospatial Data Science Lab portal; NAD83(HARN) Indiana West ftUS, 5 ft
cells) and writes `public/campus-heights.json`:

- per-building height = 90th-percentile NDHM inside the footprint (§2 of the
  brief) — replaces the 12 m default and OSM levels guesses;
- tree canopy = cells ≥ 4 m outside footprints, aggregated into ~18 m circles —
  replaces OSM tree points as shade casters.

The app picks the file up automatically at boot; building popups then show
"(lidar)" as the height source. Re-run after refreshing the OSM extract so new
footprints get measured. The `.tif` tiles are not committed; the generated
JSON is.

## Known limitations (§13 of the brief still applies)

Real door schedules are the biggest usability risk; skywalks/subwalks
must be hand-traced into `campus-overrides.json` and walked before setting
`verified: true`; not every building is conditioned — set
`{"conditioned": false}` or `{"indoorC": …}` per building in the overrides.
