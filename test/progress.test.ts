import { describe, expect, it } from 'vitest';
import { orderedLegs, progressOn, remainingRuns, remainingTime, stepDistances } from '../src/progress';
import type { Edge, Model } from '../src/types';

/** A 300 m dog-leg: 200 m east, then 100 m north. */
function legsFixture() {
  const nodes = {
    n1: { id: 'n1', x: 0, y: 0, kind: 'path' as const, bld: null, deg: 1 },
    n2: { id: 'n2', x: 200, y: 0, kind: 'path' as const, bld: null, deg: 2 },
    n3: { id: 'n3', x: 200, y: 100, kind: 'path' as const, bld: null, deg: 1 },
  };
  const edges = [
    { id: 0, a: 'n1', b: 'n2', kind: 'outdoor', len: 200 },
    { id: 1, a: 'n3', b: 'n2', kind: 'outdoor', len: 100 }, // stored backwards on purpose
  ] as Edge[];
  const model = { nodes } as unknown as Model;
  return orderedLegs(model, edges, 'n1');
}

describe('route progress', () => {
  const legs = legsFixture();

  it('walks the path in travel order whichever way an edge is stored', () => {
    expect(legs).toHaveLength(2);
    expect(legs[0].a).toEqual({ x: 0, y: 0 });
    expect(legs[1].a).toEqual({ x: 200, y: 0 });
    expect(legs[1].b).toEqual({ x: 200, y: 100 });
  });

  it('measures how far along and how far off you are', () => {
    const onIt = progressOn(legs, { x: 50, y: 0 })!;
    expect(onIt.along).toBeCloseTo(50, 6);
    expect(onIt.off).toBeCloseTo(0, 6);
    expect(onIt.total).toBeCloseTo(300, 6);

    const beside = progressOn(legs, { x: 50, y: 12 })!;
    expect(beside.along).toBeCloseTo(50, 6);
    expect(beside.off).toBeCloseTo(12, 6);

    const onSecond = progressOn(legs, { x: 200, y: 40 })!;
    expect(onSecond.along).toBeCloseTo(240, 6);
    expect(onSecond.leg).toBe(1);
  });

  it('clamps to the ends rather than running off them', () => {
    expect(progressOn(legs, { x: -50, y: 0 })!.along).toBeCloseTo(0, 6);
    expect(progressOn(legs, { x: 200, y: 500 })!.along).toBeCloseTo(300, 6);
  });

  it('drops what you have walked and keeps the rest whole', () => {
    const runs = remainingRuns(legs, 250);
    expect(runs).toHaveLength(1);                       // the first leg is behind you
    expect(runs[0].a).toEqual({ x: 200, y: 50 });        // split mid-leg
    expect(runs[0].b).toEqual({ x: 200, y: 100 });

    const all = remainingRuns(legs, 0);
    expect(all).toHaveLength(2);
    const none = remainingRuns(legs, 300);
    expect(none).toHaveLength(0);
  });

  it('prorates the time left on the leg you are standing on', () => {
    const time = (e: Edge) => (e.id === 0 ? 200 : 100);  // one second per metre
    expect(remainingTime(legs, 0, time)).toBeCloseTo(300, 6);
    expect(remainingTime(legs, 100, time)).toBeCloseTo(200, 6);
    expect(remainingTime(legs, 250, time)).toBeCloseTo(50, 6);
    expect(remainingTime(legs, 300, time)).toBeCloseTo(0, 6);
  });

  it('places each turn along the route so the banner can follow', () => {
    expect(stepDistances(legs, [{ x: 0, y: 0 }, { x: 200, y: 0 }])).toEqual([0, 200]);
  });
});
