import type { SunPosition } from './types';

/**
 * Standard low-precision solar position (same maths as suncalc).
 * Returns altitude (radians above horizon) and compass bearing (radians, 0 = north, clockwise).
 */
export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const rad = Math.PI / 180;
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const e = rad * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = rad * lat;
  const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  return { alt, bearing: (az + Math.PI) % (2 * Math.PI) };
}
