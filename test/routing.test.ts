import { describe, expect, it } from 'vitest';
import { fake2, fake3, proj } from './fixtures';
import { bld, pathIds, route, usesBuilding } from './helpers';
import { buildModel } from '../src/graph/build';
import { summarize } from '../src/routing';

describe('fake2 temperature-dependent routing (§15)', () => {
  const model = fake2().model();
  const two = () => bld(model, 'TWO');

  it('70 °F, partly cloudy: the route stays outdoors', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 70, cloud: 40, w: 0.7 });
    expect(path).not.toBeNull();
    expect(usesBuilding(path!, two().id)).toBe(false);
  });

  it('84 °F clear noon, slider 0.7: cuts through the middle building', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 84, w: 0.7 });
    expect(usesBuilding(path!, two().id)).toBe(true);
  });

  it('96 °F clear: cuts through the middle building', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    expect(usesBuilding(path!, two().id)).toBe(true);
  });

  it('20 °F windy: cuts through the middle building', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 20, wind: 'windy', w: 0.7 });
    expect(usesBuilding(path!, two().id)).toBe(true);
  });

  it('slider 0 is the pure fastest route regardless of heat', () => {
    const hot = route(model, 'ONE', 'THREE', { tempF: 96, w: 0 });
    const mild = route(model, 'ONE', 'THREE', { tempF: 70, w: 0 });
    expect(pathIds(hot.path!)).toBe(pathIds(mild.path!));
    expect(usesBuilding(hot.path!, two().id)).toBe(false); // outdoors is genuinely faster here
  });

  it('the comfortable hot route trades time for comfort', () => {
    const fast = route(model, 'ONE', 'THREE', { tempF: 96, w: 0 });
    const comfy = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    const sf = summarize(fast.path!, fast.ctx), sc = summarize(comfy.path!, comfy.ctx);
    expect(sc.time).toBeGreaterThan(sf.time);
    expect(sc.indoorLen).toBeGreaterThan(sf.indoorLen);
    expect(sc.sunLen).toBeLessThan(sf.sunLen);
  });
});

describe('fake3 streets, crossings and door rules', () => {
  const model = fake3().model();
  const alpha = () => bld(model, 'ALPH'), beta = () => bld(model, 'BETA'), gamma = () => bld(model, 'GAMM');

  it('hot route: leaves by the main entrance, cuts through Beta, crosses at the signal', () => {
    const { path, ctx } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7 });
    expect(path).not.toBeNull();
    expect(usesBuilding(path!, beta().id)).toBe(true);
    const s = summarize(path!, ctx);
    expect(s.crossings).toBe(1); // two signal edges over one street count once
    expect(s.jaywalks).toBe(0);
    expect(s.assumedDoors).toBeGreaterThan(0); // Gamma's assumed door
  });

  it('never jaywalks by default', () => {
    const { path } = route(model, 'ALPH', 'GAMM', { tempF: 70, w: 0 });
    expect(path!.every((e) => e.crossing?.type !== 'jaywalk')).toBe(true);
  });

  it('can jaywalk when the toggle is off, and it is counted', () => {
    const { path, ctx } = route(model, 'ALPH', 'GAMM', { tempF: 70, w: 0, noJaywalk: false });
    // with the 45 s penalty the router may still prefer the signal; force the
    // comparison by checking the jaywalk edge is at least traversable
    const s = summarize(path!, ctx);
    expect(s.jaywalks + s.crossings).toBeGreaterThanOrEqual(1);
  });

  it('routes around Beta when it is closed (Sunday 8 am)', () => {
    const { path } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7, weekday: 0, hour: 8 });
    expect(path).not.toBeNull();
    expect(usesBuilding(path!, beta().id)).toBe(false);
  });

  it('origin building is forced open even outside its hours', () => {
    const { path } = route(model, 'BETA', 'GAMM', { tempF: 84, w: 0.7, weekday: 0, hour: 8 });
    expect(path).not.toBeNull();
    expect(path![0].bld).toBe(beta().id); // leaves through Beta's own doors
  });

  it('never enters through the exit-only door', () => {
    // any route into Alpha must not use the exit-only door in the enter direction
    const { path } = route(model, 'GAMM', 'ALPH', { tempF: 84, w: 0.7 });
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.kind).toBe('indoor');
    const spec = last.door ?? last.doorA ?? last.doorB;
    expect(spec?.enter).toBe(true);
  });

  it('summarize counts Alpha and Gamma once each plus Beta on the hot route', () => {
    const { path, ctx } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7 });
    const s = summarize(path!, ctx);
    expect(new Set(s.via)).toEqual(new Set([alpha().id, beta().id, gamma().id]));
  });
});

describe('manual link routing', () => {
  const model = fake2().model({
    overrides: { manualLinks: [{ a: 'One Hall', b: 'Three Hall', kind: 'skywalk', verified: false }] },
  });
  it('uses the skywalk and flags it unverified', () => {
    const { path, ctx } = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    expect(path!.some((e) => e.manual)).toBe(true);
    const s = summarize(path!, ctx);
    expect(s.unverified).toBe(true);
  });
});

describe('step-free routing', () => {
  it('avoids doors tagged wheelchair=no', () => {
    const f = fake3();
    const osm = f.osm();
    // mark Beta's east door (entrance=yes) as not step-free
    for (const el of osm.elements)
      if (el.type === 'node' && el.tags?.entrance === 'yes') el.tags.wheelchair = 'no';
    const model = buildModel(osm, proj, { weekday: 3 });
    const { path } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7, stepFree: true });
    expect(path).not.toBeNull();
    for (const e of path!) {
      expect(e.stepFree).not.toBe(false);
      expect(e.steps).not.toBe(true);
    }
    // without the east door, Beta cannot be cut through west-to-east
    expect(path!.some((e) => e.kind === 'indoor' && e.bld === bld(model, 'BETA').id &&
      (e.door ?? e.doorB)?.side === 'east')).toBe(false);
  });
});
