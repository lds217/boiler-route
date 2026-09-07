import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BBOX } from '../src/constants';
import { createProjection } from '../src/geometry';
import { buildModel } from '../src/graph/build';
import { extractBasemap } from '../src/basemap';
import { computeShade } from '../src/shade';
import { buildContext, dijkstra, summarize } from '../src/routing';
import { directions } from '../src/directions';
import { computeOpen } from '../src/hours';
import { fToC } from '../src/comfort';
import type { OsmData } from '../src/types';

// Smoke test against the bundled real extract (skipped if absent).
const path = new URL('../public/boiler-route-data.json', import.meta.url).pathname;
let osm: OsmData | null = null;
try { osm = JSON.parse(readFileSync(path, 'utf8')); } catch { /* not fetched */ }

describe.skipIf(!osm)('real Purdue extract', () => {
  const proj = createProjection(BBOX);
  const model = buildModel(osm!, proj, { weekday: 3 });

  it('builds a substantial model', () => {
    console.log(`buildings=${model.buildings.length} named=${model.buildings.filter(b=>b.named).length} edges=${model.edges.length} trees=${model.trees.length} crossings=${model.crossings} jaywalks=${model.jaywalks} gaps=${model.gapsClosed}`);
    expect(model.buildings.length).toBeGreaterThan(10);
    expect(model.buildings.filter((b) => b.named).length).toBeGreaterThan(5);
    expect(model.edges.length).toBeGreaterThan(200);
    const campus = model.buildings.filter((b) => b.campus);
    const off = model.buildings.filter((b) => !b.campus);
    console.log(`campus=${campus.length} off-campus=${off.length}; off-campus named: ${off.filter((b) => b.named).map((b) => b.name).slice(0, 8).join('; ')}`);
    expect(campus.length).toBeGreaterThan(20);
    // at least one off-campus building proves the Purdue polygon was found
    // (with no polygon the fallback marks everything campus)
    expect(off.length).toBeGreaterThanOrEqual(1);
    for (const b of off) expect(model.nodes[b.id + ':hub']).toBeUndefined();
  });

  it('knows which road most crossings cross, so risk is priced by class', () => {
    const cross = model.edges.filter((e) => e.crossing);
    const known = cross.filter((e) => e.crossing!.klass);
    const byClass = new Map<string, number>();
    for (const e of known) byClass.set(e.crossing!.klass!, (byClass.get(e.crossing!.klass!) ?? 0) + 1);
    console.log(`crossings classified: ${known.length}/${cross.length}`, [...byClass].sort((a, b) => b[1] - a[1]));
    expect(known.length / cross.length).toBeGreaterThan(0.7);
    // campus is bounded by primary roads; if none are seen, the match is broken
    expect(byClass.get('primary') ?? 0).toBeGreaterThan(0);
  });

  it('extracts a basemap', () => {
    const bm = extractBasemap(osm!, proj);
    console.log(`ground=${bm.ground.length} lines=${bm.lines.length}`);
    expect(bm.lines.length).toBeGreaterThan(50);
  });

  it('routes between two named buildings under hot and cold conditions', () => {
    const named = model.buildings.filter((b) => b.named && b.doorCount > 0);
    const from = named[0], to = named[named.length - 1];
    const sun = { alt: Math.PI / 3, bearing: Math.PI };
    const { sunFrac } = computeShade(model, sun);
    const open = computeOpen(model.buildings, 3, 12);
    open[from.id] = true; open[to.id] = true;
    for (const tempF of [96, 20]) {
      const ctx = buildContext(model, { sunFrac, sun, tempC: fToC(tempF), wind: 'breezy', cloudPct: 0, w: 0.7, open, stepFree: false, noJaywalk: true, mins: 720 });
      const path = dijkstra(model, from.id + ':hub', to.id + ':hub', ctx);
      expect(path, `route ${from.abbr}->${to.abbr} at ${tempF}F`).not.toBeNull();
      const s = summarize(path!, ctx);
      const steps = directions(model, path!, from.id + ':hub', ctx);
      console.log(`${from.abbr}->${to.abbr} @${tempF}F: ${Math.round(s.len)}m ${Math.round(s.time)}s indoor=${Math.round(s.indoorLen)}m sun=${Math.round(s.sunLen)}m steps=${steps.length}`);
      expect(s.len).toBeGreaterThan(0);
      expect(steps.length).toBeGreaterThan(0);
    }
  });

  const heightsPath = new URL('../public/campus-heights.json', import.meta.url).pathname;
  let heights: import('../src/types').HeightsData | null = null;
  try { heights = JSON.parse(readFileSync(heightsPath, 'utf8')); } catch { /* not generated */ }

  it.skipIf(!heights)('applies lidar heights and canopy, and shade stays fast', () => {
    const m = buildModel(osm!, proj, { weekday: 3, heights });
    const lidar = m.buildings.filter((b) => b.heightSource === 'lidar');
    console.log(`lidar heights: ${lidar.length}/${m.buildings.length} buildings, canopy casters: ${m.trees.length}`);
    expect(lidar.length).toBeGreaterThan(40);
    for (const b of lidar) { expect(b.height).toBeGreaterThan(2); expect(b.height).toBeLessThan(120); }
    expect(m.trees.length).toBeGreaterThan(100); // canopy circles replaced OSM tree points
    // The tiles cover only part of the bbox; south of them OSM trees must survive,
    // otherwise uncovered ground routes as treeless full sun.
    const cov = heights!.coverage;
    if (cov && cov.south > BBOX[0]) {
      const south = m.trees.filter((t) => proj.ll(t.c)[0] < cov.south);
      expect(south.length, 'OSM trees kept south of lidar coverage').toBeGreaterThan(10);
      const canopyS = heights!.canopy.filter((c) => c.lat < cov.south);
      expect(canopyS.length, 'no canopy circles below coverage').toBe(0);
    }
    const t0 = performance.now();
    const { sunFrac } = computeShade(m, { alt: Math.PI / 3, bearing: Math.PI });
    const ms = performance.now() - t0;
    console.log(`computeShade with ${m.buildings.length + m.trees.length} casters: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
    // canopy must actually shade something outdoors
    let shaded = 0, outdoor = 0;
    for (const e of m.edges) if (e.kind === 'outdoor') { outdoor++; if (sunFrac[e.id] < 1) shaded++; }
    expect(shaded).toBeGreaterThan(outdoor * 0.05);
  });

  it('every named building with doors is reachable from the first one', () => {
    const named = model.buildings.filter((b) => b.named && b.doorCount > 0);
    const sun = { alt: Math.PI / 3, bearing: Math.PI };
    const { sunFrac } = computeShade(model, sun);
    const open = computeOpen(model.buildings, 3, 12);
    for (const b of model.buildings) open[b.id] = true;
    const ctx = buildContext(model, { sunFrac, sun, tempC: 21, wind: 'calm', cloudPct: 0, w: 0, open, stepFree: false, noJaywalk: true, mins: 720 });
    const from = named[0];
    let ok = 0, fail: string[] = [];
    for (const b of named.slice(1)) {
      const p = dijkstra(model, from.id + ':hub', b.id + ':hub', ctx);
      if (p) ok++; else fail.push(b.abbr);
    }
    console.log(`reachable: ${ok}/${named.length - 1}${fail.length ? ' unreachable: ' + fail.join(',') : ''}`);
    expect(ok).toBeGreaterThan((named.length - 1) * 0.8);
  });
});
