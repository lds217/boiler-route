import { RAIN_SATURATION_MM, RAIN_STRESS_MAX } from './constants';
import type { Wind } from './types';

/**
 * COMFORT MODEL
 * Cost of an edge = walking time × (1 + w × stress(feels-like temperature)).
 * "w" is the slider (0 = pure fastest). Structure follows CoolWalks (Wolf,
 * Vierø, Szell, Sci Rep 2025): distance in sun is experienced as alpha times
 * longer; here alpha depends on how hot or cold it actually is.
 *
 * feels-like follows the shape of UTCI, the index field studies find tracks
 * pedestrian thermal sensation best (r = 0.81, Dresden thermal walks).
 * Direct sun raises UTCI by roughly 8–11 °C at midday in summer (Chongqing
 * campus study); tree shade cuts mean radiant temperature by up to 20 °C.
 * So sun is modelled as up to +10 °C at zenith on a clear sky, scaled by
 * solar elevation and reduced by cloud cover. Indoors is a conditioned 22 °C
 * unless a campus override says otherwise.
 *
 * stress() is piecewise linear on the UTCI thermal stress categories:
 * no stress 0, slight 0.5, moderate 1.5, strong 3, very strong 5, extreme 8.
 */
export const INDOOR_C = 22;
export const SUN_MAX_C = 10;
export const CLOUD_CUT = 0.75;
export const WIND_C: Record<Wind, number> = { calm: 0, breezy: 3, windy: 6 };

const STRESS_PTS: [number, number][] = [
  [-40, 8], [-27, 5], [-13, 3], [0, 1.5], [9, 0.5], [18, 0], [26, 0], [32, 1.5], [38, 3], [46, 5], [55, 8],
];

export function stress(tC: number): number {
  const P = STRESS_PTS;
  if (tC <= P[0][0]) return P[0][1];
  if (tC >= P[P.length - 1][0]) return P[P.length - 1][1];
  for (let i = 1; i < P.length; i++) {
    if (tC <= P[i][0]) {
      const [x0, y0] = P[i - 1], [x1, y1] = P[i];
      return y0 + ((y1 - y0) * (tC - x0)) / (x1 - x0);
    }
  }
  return 0;
}

/**
 * Extra thermal stress from getting rained or snowed on, 0 at dry and rising to
 * RAIN_STRESS_MAX. Wet clothing is uncomfortable at any temperature, so this is
 * added to the temperature stress rather than folded into feels-like.
 */
export function rainStress(mmPerHour: number): number {
  if (!(mmPerHour > 0)) return 0;
  return RAIN_STRESS_MAX * Math.min(1, mmPerHour / RAIN_SATURATION_MM);
}

export function feelsLike(tAirC: number, sunFrac: number, sunAlt: number, wind: Wind, cloudPct: number): number {
  const sunK = Math.max(0, Math.sin(sunAlt)) * sunFrac * (1 - (CLOUD_CUT * cloudPct) / 100);
  let t = tAirC + SUN_MAX_C * sunK;
  const wc = WIND_C[wind] || 0;
  t -= tAirC < 18 ? wc * (1 - 0.3 * sunK) : wc * 0.3;
  return t;
}

export const fToC = (f: number): number => ((f - 32) * 5) / 9;
export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const windClass = (mph: number): Wind => (mph < 8 ? 'calm' : mph < 16 ? 'breezy' : 'windy');
