import { describe, expect, it } from 'vitest';
import { Fx } from './fixtures';
import { computeShade } from '../src/shade';
import { pointInRing } from '../src/geometry';
import type { Model } from '../src/types';

/** Sun due south, 60 deg up: shadows fall due north. */
const SOUTH_SUN = { alt: Math.PI / 3, bearing: Math.PI };

/** An L: a bar along the south, and a wing running north up its east end. The
 *  notch (west of the wing, north of the bar) is open sky. */
function ellBuilding(): Model {
  const f = new Fx();
  f.building([[0, 0], [60, 0], [60, 60], [40, 60], [40, 20], [0, 20]],
    { building: 'yes', name: 'Ell Hall', height: '20' });
  f.way([[5, 50], [35, 50]], { highway: 'footway', name: 'Notch Walk' });
  f.way([[5, 50], [5, 80], [70, 80]], { highway: 'footway' });
  return f.model();
}

function squareBuilding(): Model {
  const f = new Fx();
  f.building([[0, 0], [40, 0], [40, 40], [0, 40]], { building: 'yes', name: 'Box Hall', height: '20' });
  f.way([[-10, 60], [50, 60]], { highway: 'footway' });
  return f.model();
}

describe('drawn shadows match the shade the router uses', () => {
  it('a convex footprint stays a single swept piece', () => {
    const m = squareBuilding();
    const { shadows } = computeShade(m, SOUTH_SUN);
    // one caster, one ring: the hull of a convex shape and its copy is exact
    expect(m.trees).toHaveLength(0);
    expect(m.buildings).toHaveLength(1);
    expect(shadows).toHaveLength(1);
  });

  it('a concave footprint is drawn in pieces, not as its hull', () => {
    const m = ellBuilding();
    const { shadows } = computeShade(m, SOUTH_SUN);
    // the shape, its translated copy, and one quad per wall
    expect(shadows.length).toBe(2 + m.buildings[0].ring.length);
  });

  it('leaves the courtyard sunlit instead of filling it in', () => {
    const m = ellBuilding();
    const { sunFrac, shadows } = computeShade(m, SOUTH_SUN);
    const walk = m.edges.find((e) => e.name === 'Notch Walk')!;
    // the router sees full sun there: the south wall is 30 m away and casts 11.5 m
    expect(sunFrac[walk.id]).toBe(1);
    // and nothing drawn covers it, which the convex hull of the L would have
    const p = { x: 20, y: 50 };
    expect(shadows.some((r) => pointInRing(p, r))).toBe(false);
  });

  it('still shades the ground right behind a wall', () => {
    const m = ellBuilding();
    const { shadows } = computeShade(m, SOUTH_SUN);
    const p = { x: 20, y: 25 }; // 5 m north of the south bar, well inside its 11.5 m shadow
    expect(shadows.some((r) => pointInRing(p, r))).toBe(true);
  });

  it('night casts nothing', () => {
    const { shadows, sunFrac } = computeShade(ellBuilding(), { alt: -0.2, bearing: Math.PI });
    expect(shadows).toHaveLength(0);
    expect([...sunFrac].every((v) => v === 0)).toBe(true);
  });
});
