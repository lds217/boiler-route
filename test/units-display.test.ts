import { describe, expect, it } from 'vitest';
import { fmtDist, fmtHeight } from '../src/units';

describe('distance display', () => {
  it('shows metres and kilometres', () => {
    expect(fmtDist(0, 'metric')).toBe('1 m');   // never a bare zero on a step
    expect(fmtDist(42.4, 'metric')).toBe('42 m');
    expect(fmtDist(999, 'metric')).toBe('999 m');
    expect(fmtDist(1500, 'metric')).toBe('1.5 km');
  });

  it('shows feet, then miles once feet get unwieldy', () => {
    expect(fmtDist(0, 'imperial')).toBe('5 ft');
    expect(fmtDist(30, 'imperial')).toBe('100 ft');  // 98.4 ft, rounded to 5
    expect(fmtDist(100, 'imperial')).toBe('330 ft');
    expect(fmtDist(304.8, 'imperial')).toBe('1000 ft');
    expect(fmtDist(400, 'imperial')).toBe('0.2 mi');
    expect(fmtDist(1609.344, 'imperial')).toBe('1.0 mi');
  });

  it('shows heights in whole units', () => {
    expect(fmtHeight(46.6, 'metric')).toBe('47 m');
    expect(fmtHeight(46.6, 'imperial')).toBe('153 ft');
  });
});
