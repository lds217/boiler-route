import { angDiff, bearingDeg, compass8 } from './geometry';
import type { DirectionStep, DoorSpec, Edge, Model, RouteContext, XY } from './types';

interface WalkGroup { type: 'walk'; verb: string; name: string | null; len: number; sunLen: number; lastBr: number; start: XY }
interface CrossGroup { type: 'cross'; street?: string; ctype: string; len: number; start: XY; lastBr: number }
interface InsideGroup { type: 'inside'; bld: string; len: number; start: XY; enter: string | null; exit: string | null; fromHub: boolean; toHub: boolean }
interface LinkGroup { type: 'link'; kind: string | null; len: number; start: XY; to: string | null; verified?: boolean }
type Group = WalkGroup | CrossGroup | InsideGroup | LinkGroup;

const doorText = (e: Edge, nodeId: string): string | null => {
  const d: DoorSpec | undefined = e.door || (e.a === nodeId ? e.doorA : e.doorB);
  if (!d) return null;
  const side = d.side ? ` on the ${d.side} side` : '';
  return d.inside ? '' : `${d.tagged ? 'the ' + d.label : 'a door'}${side}${d.assumed ? ' (unmapped, assumed)' : ''}`;
};

export function directions(model: Model, path: Edge[], srcNode: string, ctx: RouteContext): DirectionStep[] {
  const N = model.nodes;
  const groups: Group[] = [];
  let cur = srcNode, g: Group | null = null;
  const flush = () => { if (g) { groups.push(g); g = null; } };

  for (const e of path) {
    const from = cur, to = e.a === cur ? e.b : e.a;
    cur = to;
    const A = N[from], B = N[to], br = bearingDeg(A, B);
    if (e.kind === 'outdoor' && e.crossing) {
      if (g && g.type === 'cross' && g.street === e.crossing.street) { g.len += e.len; continue; }
      flush();
      g = { type: 'cross', street: e.crossing.street, ctype: e.crossing.type, len: e.len, start: A, lastBr: br };
      continue;
    }
    if (e.kind === 'outdoor') {
      // Tiny stitch connectors never create turns ("Turn around 0 m" bug).
      if (e.connector && e.len < 5 && g && (g.type === 'walk' || g.type === 'cross')) { g.len += e.len; continue; }
      const sun = ctx.sunFrac[e.id], nm = e.connector ? null : e.name ?? null;
      if (g && g.type === 'walk' && Math.abs(angDiff(g.lastBr, br)) < 35 && (!nm || !g.name || nm === g.name)) {
        g.len += e.len; g.sunLen += e.len * sun; g.lastBr = br;
        if (nm && !g.name) g.name = nm;
        continue;
      }
      let verb = 'Head ' + compass8(br);
      if (g && (g.type === 'walk' || g.type === 'cross')) {
        const d = angDiff(g.lastBr, br);
        verb = Math.abs(d) >= 150 ? 'Turn around' : Math.abs(d) < 35 ? 'Continue' : d > 0 ? 'Turn right' : 'Turn left';
      }
      flush();
      g = { type: 'walk', verb, name: nm, len: e.len, sunLen: e.len * sun, lastBr: br, start: A };
    } else if (e.kind === 'indoor') {
      if (g && g.type === 'inside' && g.bld === e.bld) { g.len += e.len; g.exit = doorText(e, to); g.toHub = B.kind === 'hub'; continue; }
      flush();
      g = {
        type: 'inside', bld: e.bld!, len: e.len, start: A,
        enter: doorText(e, from), exit: doorText(e, to),
        fromHub: A.kind === 'hub', toHub: B.kind === 'hub',
      };
    } else {
      flush();
      g = { type: 'link', kind: e.linkKind ?? null, len: e.len, start: A, to: e.bldB || null, verified: e.verified };
    }
  }
  flush();

  return groups.map((s): DirectionStep => {
    const m = Math.round(s.len);
    if (s.type === 'walk') {
      const f = s.len ? s.sunLen / s.len : 0;
      const sub = s.len > 25 ? (f > 0.66 ? 'mostly in sun' : f < 0.33 ? 'mostly shaded' : 'sun and shade') : '';
      const join = s.verb.startsWith('Head') ? ' along ' : ' onto ';
      return { icon: f > 0.66 ? 'su' : f < 0.33 ? 'sh' : 'mx', text: s.verb + (s.name ? join + s.name : ''), sub, m, at: s.start };
    }
    if (s.type === 'cross') {
      const how = ({
        signal: 'at the signal', marked: 'at the marked crossing',
        plain: 'at the crossing', jaywalk: 'no crossing mapped here, take care',
      } as Record<string, string>)[s.ctype];
      return {
        icon: s.ctype === 'jaywalk' ? 'su' : 'sh',
        text: `Cross ${s.street || 'the street'}`, sub: how, m, at: s.start,
        warn: s.ctype === 'jaywalk',
      };
    }
    if (s.type === 'inside') {
      const ab = model.byId[s.bld].abbr;
      let text: string, sub = '';
      if (s.fromHub && s.toHub) text = `Stay inside ${ab}`;
      else if (s.fromHub) { text = `Leave ${ab}`; sub = s.exit ? `through ${s.exit}` : ''; }
      else if (s.toHub) { text = `Enter ${ab}`; sub = (s.enter ? `through ${s.enter}, ` : '') + 'you have arrived'; }
      else { text = `Cut through ${ab}`; sub = `in ${s.enter || 'one door'}, out ${s.exit || 'another'}`; }
      return { icon: 'in', text, sub, m, at: s.start };
    }
    const ab = s.to ? model.byId[s.to].abbr : null;
    return {
      icon: 'in', text: `Take the ${s.kind}${ab ? ' to ' + ab : ''}`,
      sub: s.verified === false ? 'not verified on foot' : '', m, at: s.start,
    };
  });
}
