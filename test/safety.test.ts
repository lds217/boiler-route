import { describe, expect, it } from 'vitest';
import { Fx, fake2, fake3 } from './fixtures';
import { NIGHT_SUN, NOON_SUN, bld, route, usesBuilding } from './helpers';
import { computeShade } from '../src/shade';
import { buildContext, crossRisk, edgeTime, litFactor, summarize } from '../src/routing';
import { fToC, rainStress } from '../src/comfort';
import { CROSS_RISK_SEC, JAYWALK_RISK_FACTOR, NIGHT_LIT_FACTOR } from '../src/constants';
import type { Edge, Model, RouteContext } from '../src/types';

/** Two equally long walkways between the same ends: one lit, one explicitly not. */
function litChoice(): Model {
  const f = new Fx();
  f.building([[-20, -10], [20, -10], [20, 10], [-20, 10]], { building: 'yes', name: 'West Gate' });
  f.building([[280, -10], [320, -10], [320, 10], [280, 10]], { building: 'yes', name: 'East Gate' });
  f.way([[0, 20], [150, 60], [300, 20]], { highway: 'footway', lit: 'yes', name: 'Lit Walk' });
  f.way([[0, -20], [150, -60], [300, -20]], { highway: 'footway', lit: 'no', name: 'Dark Walk' });
  f.way([[0, 20], [0, 0], [0, -20]], { highway: 'footway' });
  f.way([[300, 20], [300, 0], [300, -20]], { highway: 'footway' });
  return f.model();
}

function ctxFor(model: Model, night: boolean, tempF = 70, precipMm = 0): RouteContext {
  const sun = night ? NIGHT_SUN : NOON_SUN;
  return buildContext(model, {
    sunFrac: computeShade(model, sun).sunFrac, sun, tempC: fToC(tempF), wind: 'calm', cloudPct: 0,
    w: 0.7, open: Object.fromEntries(model.buildings.map((b) => [b.id, true])),
    stepFree: false, noJaywalk: true, mins: night ? 1320 : 720, precipMm,
  });
}
const crossEdge = (klass: string, type: 'marked' | 'jaywalk'): Edge =>
  ({ id: 0, a: 'a', b: 'b', kind: 'outdoor', len: 5, crossing: { type, klass } } as Edge);
const usesWay = (path: Edge[], name: string) => path.some((e) => e.name === name);

describe('night lighting', () => {
  const model = litChoice();

  it('lighting costs nothing by day', () => {
    const ctx = ctxFor(model, false);
    expect(ctx.night).toBe(false);
    for (const e of model.edges) expect(litFactor(e, ctx)).toBe(1);
  });

  it('after dark, unlit costs more than unmapped, which costs more than lit', () => {
    const ctx = ctxFor(model, true);
    expect(ctx.night).toBe(true);
    const lit = model.edges.find((e) => e.name === 'Lit Walk')!;
    const dark = model.edges.find((e) => e.name === 'Dark Walk')!;
    const unmapped = model.edges.find((e) => e.kind === 'outdoor' && e.lit == null)!;
    expect(litFactor(lit, ctx)).toBe(NIGHT_LIT_FACTOR.yes);
    expect(litFactor(unmapped, ctx)).toBe(NIGHT_LIT_FACTOR.unknown);
    expect(litFactor(dark, ctx)).toBe(NIGHT_LIT_FACTOR.no);
    expect(NIGHT_LIT_FACTOR.yes).toBeLessThan(NIGHT_LIT_FACTOR.unknown);
    expect(NIGHT_LIT_FACTOR.unknown).toBeLessThan(NIGHT_LIT_FACTOR.no);
  });

  it('the route takes the lit walk at night', () => {
    const night = route(model, 'WG', 'EG', { w: 0, sun: NIGHT_SUN, hour: 22 });
    expect(night.path).not.toBeNull();
    expect(usesWay(night.path!, 'Lit Walk')).toBe(true);
    expect(usesWay(night.path!, 'Dark Walk')).toBe(false);
  });

  it('summarize counts unlit metres at night and none by day', () => {
    const night = route(model, 'WG', 'EG', { w: 0, sun: NIGHT_SUN, hour: 22 });
    const day = route(model, 'WG', 'EG', { w: 0, sun: NOON_SUN, hour: 12 });
    // the short connectors have no lit tag, so a night route still reports some
    expect(summarize(night.path!, night.ctx).unlitLen).toBeGreaterThan(0);
    expect(summarize(day.path!, day.ctx).unlitLen).toBe(0);
  });
});

describe('crossing risk scales with the road', () => {
  const ctx = ctxFor(fake3().model(), false);
  const nightCtx = ctxFor(fake3().model(), true);

  it('a bigger road costs more to cross', () => {
    const res = crossRisk(crossEdge('residential', 'marked'), ctx);
    const sec = crossRisk(crossEdge('secondary', 'marked'), ctx);
    const pri = crossRisk(crossEdge('primary', 'marked'), ctx);
    expect(res).toBe(CROSS_RISK_SEC.residential);
    expect(res).toBeLessThan(sec);
    expect(sec).toBeLessThan(pri);
  });

  it('crossing away from a crossing multiplies that risk', () => {
    expect(crossRisk(crossEdge('primary', 'jaywalk'), ctx)).toBe(CROSS_RISK_SEC.primary * JAYWALK_RISK_FACTOR);
  });

  it('the risk rises again after dark', () => {
    expect(crossRisk(crossEdge('primary', 'marked'), nightCtx))
      .toBeGreaterThan(crossRisk(crossEdge('primary', 'marked'), ctx));
  });

  it('an edge that crosses nothing carries no risk', () => {
    expect(crossRisk({ id: 0, a: 'a', b: 'b', kind: 'outdoor', len: 50 } as Edge, ctx)).toBe(0);
  });

  it('the fixture street is classified, so its crossings are priced', () => {
    const model = fake3().model();
    const cross = model.edges.find((e) => e.crossing?.type === 'signal')!;
    expect(cross.crossing!.klass).toBe('residential');
    expect(crossRisk(cross, ctx)).toBeGreaterThan(0);
  });
});

describe('ice and rain', () => {
  const model = fake3().model();

  it('outdoor stairs take longer at freezing; flat ground does not', () => {
    const warm = ctxFor(model, false, 50), cold = ctxFor(model, false, 30);
    expect(warm.icy).toBe(false);
    expect(cold.icy).toBe(true);
    const steps = { id: 0, a: 'a', b: 'b', kind: 'outdoor', len: 20, steps: true } as Edge;
    const flat = { id: 1, a: 'a', b: 'b', kind: 'outdoor', len: 20 } as Edge;
    expect(edgeTime(steps, cold)).toBeGreaterThan(edgeTime(steps, warm));
    expect(edgeTime(flat, cold)).toBe(edgeTime(flat, warm));
  });

  it('rain adds stress in the open but not under cover', () => {
    expect(rainStress(0)).toBe(0);
    expect(rainStress(5)).toBeGreaterThan(rainStress(0.5));
    const dry = ctxFor(model, false, 60), wet = ctxFor(model, false, 60, 4);
    const open = model.edges.find((e) => e.kind === 'outdoor' && !e.covered)!;
    expect(wet.stress[open.id]).toBeGreaterThan(dry.stress[open.id]);
    const covered = model.edges.find((e) => e.kind === 'outdoor' && e.covered);
    if (covered) expect(wet.stress[covered.id]).toBe(dry.stress[covered.id]);
  });

  it('steady rain pushes a mild-day route indoors', () => {
    const m = fake2().model();
    const two = bld(m, 'TWO');
    const dry = route(m, 'ONE', 'THREE', { tempF: 62, w: 0.7, cloud: 100 });
    const wet = route(m, 'ONE', 'THREE', { tempF: 62, w: 0.7, cloud: 100, precipMm: 5 });
    expect(usesBuilding(dry.path!, two.id)).toBe(false);
    expect(usesBuilding(wet.path!, two.id)).toBe(true);
  });
});

describe('cutting through buildings', () => {
  const model = fake2().model();
  const two = bld(model, 'TWO');

  it('is allowed by default on a hot day', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    expect(usesBuilding(path!, two.id)).toBe(true);
  });

  it('keeps the route outdoors when switched off, but still reaches the destination', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7, noCutThrough: true });
    expect(path).not.toBeNull();
    expect(usesBuilding(path!, two.id)).toBe(false);
  });

  it('still lets you leave the start and enter the destination', () => {
    const { path } = route(model, 'ONE', 'THREE', { tempF: 96, w: 0.7, noCutThrough: true });
    const one = bld(model, 'ONE'), three = bld(model, 'THREE');
    expect(usesBuilding(path!, one.id)).toBe(true);
    expect(usesBuilding(path!, three.id)).toBe(true);
  });
});

describe('tunnels are shelter, not shortcuts', () => {
  /** Two halls far apart, joined by a long way round and a direct tunnel. */
  function tunnelPair() {
    const f = fake2();
    return f.model({
      overrides: {
        manualLinks: [{ a: 'One Hall', b: 'Three Hall', kind: 'subwalk', verified: false }],
      },
    });
  }
  const usesTunnel = (path: Edge[]) => path.some((e) => e.linkKind === 'subwalk');

  it('stays shut on a pleasant day', () => {
    const mild = route(tunnelPair(), 'ONE', 'THREE', { tempF: 70, w: 0.7, cloud: 40 });
    expect(mild.ctx.severe).toBe(false);
    expect(usesTunnel(mild.path!)).toBe(false);
  });

  it('opens in hard cold', () => {
    const cold = route(tunnelPair(), 'ONE', 'THREE', { tempF: 20, wind: 'windy', w: 0.7 });
    expect(cold.ctx.severe).toBe(true);
    expect(usesTunnel(cold.path!)).toBe(true);
  });

  it('opens in baking sun and in steady rain', () => {
    const hot = route(tunnelPair(), 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    expect(hot.ctx.severe).toBe(true);
    expect(usesTunnel(hot.path!)).toBe(true);
    const wet = route(tunnelPair(), 'ONE', 'THREE', { tempF: 62, w: 0.7, cloud: 100, precipMm: 5 });
    expect(wet.ctx.severe).toBe(true);
    expect(usesTunnel(wet.path!)).toBe(true);
  });

  it('says tunnel, not subwalk, and carries its own arrow', async () => {
    const { directions } = await import('../src/directions');
    const m = tunnelPair();
    const cold = route(m, 'ONE', 'THREE', { tempF: 20, wind: 'windy', w: 0.7 });
    const step = directions(m, cold.path!, cold.src, cold.ctx).find((s) => s.maneuver === 'tunnel')!;
    expect(step).toBeDefined();
    expect(step.text).toBe('Take the tunnel to THREE');
    expect(step.sub).toBe('not verified on foot');
  });
});

describe('a link names where it takes you', () => {
  it('names the far building whichever way it is walked', async () => {
    const { directions } = await import('../src/directions');
    const m = fake2().model({
      overrides: { manualLinks: [{ a: 'One Hall', b: 'Three Hall', kind: 'subwalk', verified: false }] },
    });
    const one = bld(m, 'ONE'), three = bld(m, 'THREE');
    const there = route(m, 'ONE', 'THREE', { tempF: 20, wind: 'windy', w: 0.7 });
    const back = route(m, 'THREE', 'ONE', { tempF: 20, wind: 'windy', w: 0.7 });
    const step = (r: typeof there, src: string) =>
      directions(m, r.path!, src, r.ctx).find((s) => s.maneuver === 'tunnel')!;
    expect(step(there, one.id + ':hub').text).toBe('Take the tunnel to THREE');
    expect(step(back, three.id + ':hub').text).toBe('Take the tunnel to ONE');
  });
});
