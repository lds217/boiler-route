import { DOOR_REACH } from './constants';
import type { Model, Place, RouteContext } from './types';

export const routeNode = (p: Place): string => (p.kind === 'building' ? p.id + ':hub' : p.nodeId);

/** Explain a "no route found" in terms the user can act on. */
export function diagnose(model: Model, origin: Place, dest: Place, ctx: RouteContext): string {
  const probs: string[] = [];
  for (const [pl, role] of [[origin, 'start'], [dest, 'destination']] as [Place, string][]) {
    const id = routeNode(pl);
    const es = model.adj[id] || [];
    if (!es.length) { probs.push(`the ${role} has no path attached`); continue; }
    if (pl.kind === 'building') {
      const b = model.byId[pl.id];
      if (!b.doorCount)
        probs.push(`${b.abbr} has no reachable door (no sidewalk within ${DOOR_REACH} m of its wall` +
          `${b.doorsSkipped.length ? ', tagged doors are ' + b.doorsSkipped.join(', ') : ''})`);
    }
  }
  if (ctx.stepFree) probs.push('step-free routing is on, which removes stairs and doors tagged wheelchair=no');
  if (ctx.noJaywalk) probs.push('crossing only at mapped crossings is on');
  return probs.length
    ? `Likely cause: ${probs.join('; ')}. Turn on the walkable network to see the gap.`
    : 'The OSM path network does not connect these two places. Turn on the walkable network to see the gap, or drop the pin somewhere else.';
}
