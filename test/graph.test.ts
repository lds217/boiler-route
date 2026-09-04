import { describe, expect, it } from 'vitest';
import { fake2, fake3 } from './fixtures';
import { bld } from './helpers';
import { allowed } from '../src/routing';

describe('fake2 graph construction', () => {
  const model = fake2().model();

  it('finds three named buildings', () => {
    expect(model.buildings).toHaveLength(3);
    expect(model.buildings.every((b) => b.named)).toBe(true);
  });

  it('closes the 3 m sidewalk gap', () => {
    expect(model.gapsClosed).toBeGreaterThanOrEqual(1);
  });

  it('assumes doors on every reachable side of untagged buildings', () => {
    for (const abbr of ['ONE', 'TWO', 'THREE']) {
      const b = bld(model, abbr);
      expect(b.doorsTagged).toBe(0);
      expect(b.doorsAssumed).toBeGreaterThanOrEqual(4);
      // a door on each of the four walls (labels may be diagonal for off-centre doors)
      const pts = [...model.doorsOf.get(b.id)!.keys()].map((id) => model.nodes[id]);
      expect(pts.some((p) => Math.abs(p.y - b.bbox.y1) < 1)).toBe(true); // north wall
      expect(pts.some((p) => Math.abs(p.y - b.bbox.y0) < 1)).toBe(true); // south wall
      expect(pts.some((p) => Math.abs(p.x - b.bbox.x0) < 1)).toBe(true); // west wall
      expect(pts.some((p) => Math.abs(p.x - b.bbox.x1) < 1)).toBe(true); // east wall
    }
  });

  it('has no streets, crossings or jaywalks', () => {
    expect(model.streets).toHaveLength(0);
    expect(model.crossings).toBe(0);
    expect(model.jaywalks).toBe(0);
  });

  it('prices indoor hub and door-to-door edges with the corridor factor', () => {
    const two = bld(model, 'TWO');
    const hubEdges = model.edges.filter((e) => e.kind === 'indoor' && e.bld === two.id &&
      (e.a === two.id + ':hub' || e.b === two.id + ':hub'));
    expect(hubEdges.length).toBeGreaterThan(0);
    // west door at (-40, 0), hub at (0, 0): straight line 40 m → stored 56 m
    const west = hubEdges.find((e) => e.door?.side === 'west');
    expect(west).toBeDefined();
    expect(west!.len).toBeCloseTo(56, 0);
  });
});

describe('fake3 graph construction', () => {
  const model = fake3().model();
  const alpha = bld(model, 'ALPH'), beta = bld(model, 'BETA'), gamma = bld(model, 'GAMM');

  it('detects the signal crossing and attaches the street name', () => {
    const crossings = model.edges.filter((e) => e.crossing && e.crossing.type === 'signal');
    expect(crossings.length).toBe(2); // two segments of one crossing way
    for (const e of crossings) expect(e.crossing!.street).toBe('Test Street');
  });

  it('detects the jaywalking north sidewalk', () => {
    expect(model.jaywalks).toBe(1);
    const jay = model.edges.find((e) => e.crossing?.type === 'jaywalk')!;
    expect(jay.crossing!.street).toBe('Test Street');
  });

  it('skips the emergency door and records why', () => {
    expect(alpha.doorsSkipped).toContain('emergency exit');
  });

  it('keeps the exit-only door one-way: it cannot be entered', () => {
    const doors = model.doorsOf.get(alpha.id)!;
    const exitId = [...doors.entries()].find(([, d]) => d.tagged && !d.enter)?.[0];
    expect(exitId).toBeDefined();
    const hubEdge = model.edges.find((e) => e.kind === 'indoor' && e.bld === alpha.id &&
      (e.a === exitId || e.b === exitId))!;
    expect(hubEdge.dir).toBe('ab'); // hub → door only
    const doorEnd = hubEdge.a === exitId ? hubEdge.a : hubEdge.b;
    expect(allowed(hubEdge, doorEnd)).toBe(false); // door → hub forbidden
    expect(allowed(hubEdge, hubEdge.a === exitId ? hubEdge.b : hubEdge.a)).toBe(true);
  });

  it('Beta has two usable tagged doors and gets no assumed ones', () => {
    expect(beta.doorsTagged).toBe(2);
    expect(beta.doorsAssumed).toBe(0);
  });

  it('Gamma is untagged and gets assumed doors, including a west one', () => {
    expect(gamma.doorsTagged).toBe(0);
    expect(gamma.doorsAssumed).toBeGreaterThan(0);
    const sides = [...model.doorsOf.get(gamma.id)!.values()].filter((d) => d.assumed).map((d) => d.side);
    expect(sides).toContain('west');
  });

  it('never assumes a door whose connector would cross the street', () => {
    // the sector-4 (east-facing) candidates for Beta sit west of the street;
    // no Gamma door may connect across Test Street
    for (const [id] of model.doorsOf.get(gamma.id)!) {
      const dn = model.nodes[id];
      for (const e of model.adj[id].filter((x) => x.kind === 'outdoor')) {
        const other = model.nodes[e.a === id ? e.b : e.a];
        // both endpoints on the same side of the street (x = 50)
        expect(Math.sign(other.x - 50)).toBe(Math.sign(dn.x - 50));
      }
    }
  });

  it('parses Beta weekday hours', () => {
    expect(beta.hoursTagged).toBe(true);
    expect(beta.hours).toEqual([7, 22]); // built with weekday=3 (Wednesday)
  });

  it('ignores the grass polygon', () => {
    expect(model.buildings.map((b) => b.abbr).sort()).toEqual(['ALPH', 'BETA', 'GAMM']);
  });
});

describe('manual links', () => {
  const model = fake2().model({
    overrides: { manualLinks: [{ a: 'One Hall', b: 'Three Hall', kind: 'skywalk', verified: false, note: 'walk it' }] },
  });
  it('adds a hub-to-hub link edge matched by name', () => {
    const link = model.edges.find((e) => e.manual);
    expect(link).toBeDefined();
    expect(link!.kind).toBe('link');
    expect(link!.linkKind).toBe('skywalk');
    expect(link!.verified).toBe(false);
    expect(link!.a).toBe(bld(model, 'ONE').id + ':hub');
    expect(link!.b).toBe(bld(model, 'THREE').id + ':hub');
  });
});
