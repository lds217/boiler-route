/**
 * Match Purdue's official building codes to the OSM building names in the
 * bundled extract, and write src/data/building-codes.json (osm name -> code).
 *
 * Matching is done here, offline, rather than in the app: the result is a small
 * reviewable table, and a name that fails to match simply keeps its generated
 * initials instead of silently getting the wrong code.
 *
 *   node scripts/building-codes.mjs [--report]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRID = /\s+(?:[A-I]\d{1,2}(?:-\d{1,2})?)(?:\s*,\s*(?:[A-I]?\d{1,2}))*(?:\s*\(Inset\))?$/;
const STOP = new Set(['of', 'and', 'the', 'for', 'at', 'a', 'purdue', 'university']);
/** Words too common to identify a building on their own. */
const GENERIC = new Set(['hall', 'building', 'center', 'centre', 'laboratory', 'laboratories', 'lab',
  'labs', 'house', 'facility', 'facilities', 'garage', 'tower', 'towers', 'annex', 'complex', 'arena',
  'pavilion', 'court', 'residence', 'research', 'science', 'sciences', 'church', 'quadrangle', 'street']);

/** Lowercase, strip punctuation, collapse spaces. Parenthetical given names are
 *  kept as tokens because OSM usually spells them out inline. */
const norm = (s) => s
  .toLowerCase()
  .replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const tokens = (s) => new Set(norm(s).split(' ').filter((w) => w && !STOP.has(w)));

const official = [];
for (const raw of readFileSync(resolve(ROOT, 'data/purdue-building-codes.txt'), 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const m = line.match(/^([A-Z0-9][A-Z0-9-]{0,5})\s+(.*)$/);
  if (!m) continue;
  const name = m[2].replace(GRID, '').replace(/\s*\(Inset\)$/, '').trim();
  if (name) official.push({ code: m[1], name, tk: tokens(name) });
}

const osm = JSON.parse(readFileSync(resolve(ROOT, 'public/boiler-route-data.json'), 'utf8'));
const names = new Set();
for (const e of osm.elements) {
  const t = e.tags;
  if (t && t.building && t.building !== 'no' && t.name) names.add(t.name);
}

/** Containment of the smaller token set in the larger: tolerant of the extra
 *  given names OSM spells out and Purdue puts in parentheses. */
function score(a, b) {
  let shared = 0, distinctive = 0;
  for (const w of a) if (b.has(w)) { shared++; if (!GENERIC.has(w)) distinctive++; }
  return { shared, distinctive, ratio: shared / Math.min(a.size, b.size) };
}

/** Renames OSM has not caught up with, and codes only the official list knows. */
const ALIAS = {
  'Honors College and Residences North': 'LEES',
  'Honors College And Residences North': 'LEES',
  'Hansen Hall': 'HANS',
  'Krannert School of Management': 'KRAN',
  'Marriot Hall': 'MRRT',          // OSM spells it with one t
  'Purdue Student Union': 'PMU',
  'Union Club Hotel': 'PMUC',
};

const byCode = new Map(official.map((o) => [o.code, o]));
const table = {};
const unmatched = [];
const used = new Map();
for (const name of [...names].sort()) {
  if (ALIAS[name]) { table[name] = ALIAS[name]; continue; }
  // an OSM name that spells out its own code, e.g. "... Engineering (MSEE)", is authoritative
  const inName = name.match(/\(([A-Z0-9][A-Z0-9-]{1,5})\)/);
  if (inName && byCode.has(inName[1])) { table[name] = inName[1]; continue; }
  const tk = tokens(name);
  let best = null, bestS = null;
  for (const o of official) {
    const s = score(tk, o.tk);
    // a match must share at least one word that actually identifies a building,
    // or "University Lutheran Church" happily becomes University Church
    if (s.distinctive < 1) continue;
    // one shared token is enough only when it is the whole of the shorter name
    if (s.shared < 2 && !(s.ratio === 1 && Math.min(tk.size, o.tk.size) === 1)) continue;
    if (s.ratio < 0.7) continue;
    if (!bestS || s.ratio > bestS.ratio || (s.ratio === bestS.ratio && s.shared > bestS.shared)) { best = o; bestS = s; }
  }
  // OSM's own parenthetical code beats generated initials even when Purdue's
  // published list has no entry for that building
  if (!best && inName) { table[name] = inName[1]; continue; }
  if (best) {
    table[name] = best.code;
    (used.get(best.code) ?? used.set(best.code, []).get(best.code)).push(name);
  } else unmatched.push(name);
}

mkdirSync(resolve(ROOT, 'src/data'), { recursive: true });
writeFileSync(resolve(ROOT, 'src/data/building-codes.json'), JSON.stringify(table, null, 2) + '\n');
console.log(`matched ${Object.keys(table).length} of ${names.size} named OSM buildings to ${new Set(Object.values(table)).size} codes`);

const dupes = [...used].filter(([, v]) => v.length > 1);
if (dupes.length) {
  console.log('\ncodes claimed by more than one building (check these):');
  for (const [code, v] of dupes) console.log(`  ${code}: ${v.join(' | ')}`);
}
if (process.argv.includes('--report')) {
  console.log('\nmatched:');
  for (const [n, c] of Object.entries(table)) console.log(`  ${c.padEnd(6)} ${n}`);
  console.log('\nno official code (keeps generated initials):');
  for (const n of unmatched) console.log(`  ${n}`);
}
