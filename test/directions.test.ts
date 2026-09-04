import { describe, expect, it } from 'vitest';
import { directions } from '../src/directions';
import { fake2, fake3 } from './fixtures';
import { route } from './helpers';

/** Assert the expected steps appear in order (other steps may sit between). */
function expectSequence(steps: { text: string; sub: string }[], expected: { text: string; sub?: string }[]) {
  let i = 0;
  for (const want of expected) {
    while (i < steps.length && !steps[i].text.includes(want.text)) i++;
    expect(i, `missing step "${want.text}" in [${steps.map((s) => s.text).join(' | ')}]`).toBeLessThan(steps.length);
    if (want.sub !== undefined) expect(steps[i].sub).toBe(want.sub);
    i++;
  }
}

describe('fake3 turn-by-turn (§15)', () => {
  const model = fake3().model();

  it('reads the canonical hot-route narrative', () => {
    const { path, ctx, src } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7 });
    const steps = directions(model, path!, src, ctx);
    expectSequence(steps, [
      { text: 'Leave ALPH', sub: 'through the main entrance on the east side' },
      { text: 'Cut through BETA', sub: 'in the main entrance on the west side, out the door on the east side' },
      { text: 'Cross Test Street', sub: 'at the signal' },
      { text: 'Enter GAMM', sub: 'through a door on the west side (unmapped, assumed), you have arrived' },
    ]);
  });

  it('flags jaywalk steps with a warning when allowed', () => {
    const { path, ctx, src } = route(model, 'ALPH', 'GAMM', { tempF: 70, w: 0, noJaywalk: false });
    const steps = directions(model, path!, src, ctx);
    for (const s of steps)
      if (s.sub === 'no crossing mapped here, take care') expect(s.warn).toBe(true);
  });

  it('never emits a zero-metre "Turn around" from stitch connectors', () => {
    const { path, ctx, src } = route(model, 'ALPH', 'GAMM', { tempF: 84, w: 0.7 });
    const steps = directions(model, path!, src, ctx);
    for (const s of steps) expect(s.text === 'Turn around' && s.m < 2).toBe(false);
  });
});

describe('fake2 directions', () => {
  const model = fake2().model();

  it('an outdoor route heads along named walks with sun hints', () => {
    const { path, ctx, src } = route(model, 'ONE', 'THREE', { tempF: 70, cloud: 40, w: 0.7 });
    const steps = directions(model, path!, src, ctx);
    expect(steps[0].text).toContain('Leave ONE');
    const walk = steps.find((s) => s.text.includes('Walk') || s.text.includes('Head') || s.text.includes('Turn'));
    expect(walk).toBeDefined();
    const long = steps.filter((s) => s.m > 25 && (s.icon === 'su' || s.icon === 'mx' || s.icon === 'sh'));
    for (const s of long) expect(['mostly in sun', 'mostly shaded', 'sun and shade']).toContain(s.sub);
    expect(steps[steps.length - 1].text).toContain('Enter THREE');
  });

  it('a skywalk link step names its destination', () => {
    const linked = fake2().model({
      overrides: { manualLinks: [{ a: 'One Hall', b: 'Three Hall', kind: 'skywalk', verified: false }] },
    });
    const { path, ctx, src } = route(linked, 'ONE', 'THREE', { tempF: 96, w: 0.7 });
    const steps = directions(linked, path!, src, ctx);
    const link = steps.find((s) => s.text.startsWith('Take the skywalk'));
    expect(link).toBeDefined();
    expect(link!.text).toBe('Take the skywalk to THREE');
    expect(link!.sub).toBe('not verified on foot');
  });
});
