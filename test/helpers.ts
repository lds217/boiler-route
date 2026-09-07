import { fToC } from '../src/comfort';
import { computeOpen } from '../src/hours';
import { buildContext, dijkstra } from '../src/routing';
import { computeShade } from '../src/shade';
import type { Edge, Model, RouteContext, SunPosition, Wind } from '../src/types';

/** High southern sun (60° up, due south), like an August noon. */
export const NOON_SUN: SunPosition = { alt: Math.PI / 3, bearing: Math.PI };

export interface RouteOpts {
  tempF?: number;
  wind?: Wind;
  cloud?: number;
  w?: number;
  weekday?: number;
  hour?: number;
  stepFree?: boolean;
  noJaywalk?: boolean;
  sun?: SunPosition;
  precipMm?: number;
}

/** Sun below the horizon, for night-safety tests. */
export const NIGHT_SUN: SunPosition = { alt: -0.3, bearing: Math.PI };

export const bld = (model: Model, abbr: string) => model.buildings.find((b) => b.abbr === abbr)!;

export function route(model: Model, fromAbbr: string, toAbbr: string, opts: RouteOpts = {}):
  { path: Edge[] | null; ctx: RouteContext; src: string } {
  const {
    tempF = 84, wind = 'breezy', cloud = 0, w = 0.7,
    weekday = 3, hour = 12, stepFree = false, noJaywalk = true, sun = NOON_SUN, precipMm = 0,
  } = opts;
  const from = bld(model, fromAbbr), to = bld(model, toAbbr);
  const open = computeOpen(model.buildings, weekday, hour);
  open[from.id] = true; // origin and destination buildings are forced open
  open[to.id] = true;
  const { sunFrac } = computeShade(model, sun);
  const ctx = buildContext(model, {
    sunFrac, sun, tempC: fToC(tempF), wind, cloudPct: cloud, w,
    open, stepFree, noJaywalk, mins: hour * 60, precipMm,
  });
  const src = from.id + ':hub';
  return { path: dijkstra(model, src, to.id + ':hub', ctx), ctx, src };
}

export const usesBuilding = (path: Edge[], id: string): boolean =>
  path.some((e) => e.kind !== 'outdoor' && (e.bld === id || e.bldA === id || e.bldB === id));

export const pathIds = (path: Edge[]): string => path.map((e) => e.id).join();
