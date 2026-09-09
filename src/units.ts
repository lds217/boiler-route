/**
 * Distance formatting. Temperatures were always Fahrenheit here; distances are
 * modelled in metres and shown in whichever the reader thinks in.
 */
const FT_PER_M = 3.280839895;
const M_PER_MILE = 1609.344;

export type Units = 'imperial' | 'metric';

/** A walking distance: feet until it is far enough that miles read better. */
export function fmtDist(metres: number, units: Units): string {
  if (units === 'imperial') {
    const ft = metres * FT_PER_M;
    if (ft < 1000) return `${Math.max(5, Math.round(ft / 5) * 5)} ft`;
    return `${(metres / M_PER_MILE).toFixed(1)} mi`;
  }
  if (metres < 1000) return `${Math.max(1, Math.round(metres))} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** A building or tree height, where a fraction of a unit never matters. */
export function fmtHeight(metres: number, units: Units): string {
  return units === 'imperial' ? `${Math.round(metres * FT_PER_M)} ft` : `${Math.round(metres)} m`;
}
