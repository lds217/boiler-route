#!/usr/bin/env node
/**
 * Fetch the study-area extract from Overpass and write public/boiler-route-data.json.
 * Run by CI weekly so end users never hit Overpass from their browsers
 * (Overpass rate-limits per IP; tile/tool policies forbid client-side bulk use).
 *
 * The BBOX is read from src/constants.ts so there is a single source of truth.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const constants = readFileSync(join(root, 'src/constants.ts'), 'utf8');
const bboxMatch = constants.match(/BBOX[^=]*=\s*\[([^\]]+)\]/);
if (!bboxMatch) throw new Error('could not read BBOX from src/constants.ts');
const bbox = bboxMatch[1].split(',').map((s) => parseFloat(s));

const queryMatch = constants.match(/overpassQuery[\s\S]*?=> `([\s\S]*?)`;/);
if (!queryMatch) throw new Error('could not read overpassQuery from src/constants.ts');
const query = queryMatch[1].replaceAll('${bbox}', bbox.join(','));

const CONTACT = process.env.BOILER_ROUTE_CONTACT || 'https://github.com/purdue-boiler-route/boiler-route';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

let lastErr = null;
for (const url of ENDPOINTS) {
  try {
    console.log(`querying ${new URL(url).host} …`);
    const r = await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `boiler-route-data-refresh (${CONTACT})`,
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.elements || !j.elements.length) throw new Error('empty response');
    j._fetched = new Date().toISOString();
    j._source = new URL(url).host;
    const out = join(root, 'public/boiler-route-data.json');
    writeFileSync(out, JSON.stringify(j));
    console.log(`wrote ${out}: ${j.elements.length} elements, fetched ${j._fetched}`);
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.error(`${new URL(url).host}: ${e.message}`);
  }
}
throw lastErr;
