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

## Known limitations (§13 of the brief still applies)

Heights default to 12 m without OSM tags (NDHM zonal stats are the planned
upgrade); real door schedules are the biggest usability risk; skywalks/subwalks
must be hand-traced into `campus-overrides.json` and walked before setting
`verified: true`; not every building is conditioned — set
`{"conditioned": false}` or `{"indoorC": …}` per building in the overrides.
