import '@fontsource-variable/inter';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { hydrateIcons, icon } from './icons';
import { fmtDist, fmtHeight, type Units } from '../units';
import { orderedLegs, progressOn, remainingRuns, remainingTime, stepDistances, type Leg } from '../progress';
import './style.css';

import campusOverrides from '../../campus-overrides.json';
import { extractBasemap, type Basemap } from '../basemap';
import { CLOUD_CUT, cToF, fToC, SUN_MAX_C, windClass } from '../comfort';
import { BBOX, overpassQuery, PIN_CONNECT } from '../constants';
import { diagnose, routeNode } from '../diagnose';
import { directions } from '../directions';
import { compassShort, createProjection } from '../geometry';
import { buildModel, nearestPathNode } from '../graph/build';
import { computeOpen, fmtClock, fmtHours } from '../hours';
import { loadBundledData, loadOverpass } from '../overpass';
import { buildContext, dijkstra, edgeTime, summarize } from '../routing';
import { computeShade } from '../shade';
import { sunPosition } from '../sun';
import type { CampusOverrides, Edge, HeightsData, Model, OsmData, Place, RouteContext, Wind, XY } from '../types';
import { loadWeather, weatherAt, type WeatherState } from '../weather';

hydrateIcons();

const proj = createProjection(BBOX);
const CAMPUS = { lat: proj.centerLat, lon: proj.centerLon };
const overrides = campusOverrides as unknown as CampusOverrides;
const DATA_URL = './boiler-route-data.json';
const STALE_DAYS = 14;

/* ================= state ================= */
let model: Model | null = null;
let rawOsm: OsmData | null = null;
let heights: HeightsData | null = null;
let basemap: Basemap | null = null;
let wx: WeatherState = { ok: false, current: null, hourly: null, fetchedAt: null, err: null };
let origin: Place | null = null, dest: Place | null = null;
let pendingField: 'from' | 'to' | null = null;
let selected: 'fast' | 'comfort' = 'comfort';
let lastRoutes: { fast: Edge[] | null; comfy: Edge[] | null; ctx: RouteContext; src: string } | null = null;
let lastPair = '';
let raf: number | null = null;
/* Live following: how far along the shown route you are, so the walked part can
   be dropped and the banner can keep up. Engages only when a fix is actually
   near the route, so looking at a route from elsewhere changes nothing. */
const FOLLOW_M = 40;      // within this of the route, you are walking it
const REROUTE_M = 45;     // beyond this, you have left it
const REROUTE_FIXES = 3;  // consecutive fixes before we redo the route
let shownLegs: Leg[] = [];
let stepAlong: number[] = [];
let doneAlong = 0;
let offFixes = 0;
let following = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtMin = (s: number): string => { const m = Math.round(s / 60); return m < 1 ? '<1 min' : `${m} min`; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sunColor = (f: number) => {
  const c1 = [85, 89, 96], c2 = [218, 170, 0]; // Steel → Rush
  return `rgb(${c1.map((v, i) => Math.round(lerp(v, c2[i], f))).join(',')})`;
};
const ll = (p: { x: number; y: number }): [number, number] => proj.ll(p);
const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const units = (): Units => (($('units') as HTMLSelectElement)?.value === 'metric' ? 'metric' : 'imperial');
const dist = (m: number) => fmtDist(m, units());

/* ================= map ================= */
// Extra canvas padding renders past the viewport so panning doesn't redraw every frame.
const map = L.map('map', { zoomControl: false, preferCanvas: true, renderer: L.canvas({ padding: window.innerWidth < 820 ? 0.2 : 0.5 }) }).setView([CAMPUS.lat, CAMPUS.lon], 17);
L.control.zoom({ position: 'topright' }).addTo(map);
const syncLabels = () => {
  const z = map.getZoom();
  syncBuildingLabels();
  // street names only once there is room for them
  if (wantStreetNames && z >= 17) labelLayer.addTo(map); else map.removeLayer(labelLayer);
};
map.on('zoomend', () => { syncLabels(); applyLineWeights(); });
map.createPane('ground').style.zIndex = '330';
map.createPane('casing').style.zIndex = '336';
map.createPane('base').style.zIndex = '340';
map.createPane('label').style.zIndex = '344';
map.createPane('shadow').style.zIndex = '350';
map.createPane('net').style.zIndex = '360';
map.createPane('routes').style.zIndex = '450';
map.createPane('gps').style.zIndex = '500'; // your own position sits above every drawn layer
// The vectors are OSM data, so attribution stays visible whatever the basemap.
// On GitHub Pages the repo is in the URL, so the issue link needs no configuring.
const issuesUrl = (): string | null => {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/);
  if (!m) return null;
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return `https://github.com/${m[1]}/${repo || m[1] + '.github.io'}/issues`;
};
map.attributionControl.addAttribution(
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
  (issuesUrl() ? ` · <a href="${issuesUrl()}">Report a map issue</a>` : ''));
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 1 });
const groundLayer = L.layerGroup().addTo(map);
const shadowLayer = L.layerGroup().addTo(map);
const netLayer = L.layerGroup();
const routeLayer = L.layerGroup().addTo(map);
const bldLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const boundsRect = L.rectangle([[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]], { color: '#555960', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);
const bldShapes: Record<string, L.Polygon> = {};
const treeLayer = L.layerGroup().addTo(map);
const tunnelLayer = L.layerGroup().addTo(map);
const doorLayer = L.layerGroup();
const crossLayer = L.layerGroup();
/** Layer switches, so every drawn thing can be checked on its own. */
const DOOR_COLOR = { tagged: '#1F5FBF', assumed: '#C77B1F', inside: '#2E7D32' };
const CROSS_COLOR: Record<string, string> = { signal: '#1F5FBF', marked: '#2E7D32', plain: '#C77B1F', jaywalk: '#B3352C' };
const HEIGHT_COLOR: Record<string, string> = { lidar: '#CBB98A', osm: '#B9C4CF', assumed: '#E6E2D6' };
let wantBldLabels = true, wantStreetNames = true, reviewHeights = false;
let doorsBuilt = false, crossBuilt = false;
function buildDoors() {
  if (doorsBuilt || !model) return;
  doorsBuilt = true;
  for (const [bid, doors] of model.doorsOf) {
    const b = model.byId[bid];
    for (const [nid, d] of doors) {
      const n = model.nodes[nid];
      if (!n) continue;
      const kind = d.inside ? 'inside' : d.tagged ? 'tagged' : 'assumed';
      L.circleMarker(ll(n), {
        pane: 'net', radius: 4, weight: 2, color: DOOR_COLOR[kind],
        fillColor: d.tagged ? DOOR_COLOR[kind] : '#FCFBF7', fillOpacity: 1,
      }).addTo(doorLayer).bindTooltip(
        `${b.abbr}: ${kind} ${d.label}${d.side ? ', ' + d.side + ' side' : ''}${d.enter && d.exit ? '' : d.enter ? ', entry only' : ', exit only'}`,
        { className: 'st' });
    }
  }
}
function buildCrossings() {
  if (crossBuilt || !model) return;
  crossBuilt = true;
  for (const e of model.edges) {
    if (!e.crossing) continue;
    L.polyline([ll(model.nodes[e.a]), ll(model.nodes[e.b])], {
      pane: 'net', color: CROSS_COLOR[e.crossing.type] ?? '#B3352C', weight: 5, opacity: 0.85, lineCap: 'round',
    }).addTo(crossLayer).bindTooltip(
      `${e.crossing.type} crossing of ${e.crossing.street ?? 'an unnamed street'}${e.crossing.klass ? ` (${e.crossing.klass})` : ''}`,
      { className: 'st' });
  }
}
/** Permanent tooltips are DOM nodes Leaflet repositions on every move, so they
    are bound only at the zooms that show them. */
let namedPolys: { poly: L.Polygon; abbr: string; id: string }[] = [];
let labelsBound = false;
let lastOpen: Record<string, boolean> = {};
function syncBuildingLabels() {
  const want = wantBldLabels && map.getZoom() >= 16;
  if (want === labelsBound) return;
  labelsBound = want;
  for (const { poly, abbr, id } of namedPolys) {
    if (!want) { poly.unbindTooltip(); continue; }
    poly.bindTooltip(abbr, { permanent: true, direction: 'center', className: 'bl' });
    if (lastOpen[id] === false) poly.getTooltip()?.getElement()?.classList.add('closed');
  }
}

const GROUND_FILL: Record<string, string> = {
  green: '#DCDCC6', wood: '#CBCFB2', water: '#C4D6D3', parking: '#E3DFD2', pitch: '#D5D9C0', sand: '#EBD99F', dirt: '#DED7C6',
};
/* Road fills sit on a darker casing, and both scale with zoom, the way a raster
   basemap does. Widths are metres-ish: z<=15, 16, 17, 18, z>=19. */
type LineClass = 'major' | 'minor' | 'service' | 'walk';
const LINE_FILL: Record<LineClass, string> = { major: '#FFFFFF', minor: '#FFFFFF', service: '#F8F5ED', walk: '#F0EBE0' };
const LINE_CASE: Record<LineClass, string> = { major: '#CFC3A4', minor: '#D8CFB6', service: '#E0D8C4', walk: '#D5CDB8' };
const LINE_W: Record<LineClass, number[]> = {
  major: [3, 5.5, 9, 14, 20],
  minor: [2.2, 4, 6.5, 10, 15],
  service: [1.2, 2, 3.2, 5, 7],
  walk: [0.8, 1.3, 2, 2.8, 3.6],
};
const zStep = (z: number) => (z <= 15 ? 0 : z >= 19 ? 4 : z - 15);
let baseLines: { fill: L.Polyline; casing: L.Polyline | null; klass: LineClass }[] = [];
const labelLayer = L.layerGroup();

function applyLineWeights() {
  const i = zStep(map.getZoom());
  for (const b of baseLines) {
    const w = LINE_W[b.klass][i];
    b.fill.setStyle({ weight: w, dashArray: b.klass === 'walk' && w >= 2 ? `${w * 1.6} ${w * 1.4}` : undefined });
    b.casing?.setStyle({ weight: w + (i >= 3 ? 3 : 2) });
  }
}

function drawBasemap() {
  groundLayer.clearLayers(); labelLayer.clearLayers(); baseLines = [];
  if (!basemap || $('basemap') && ($('basemap') as HTMLSelectElement).value !== 'builtin') return;
  for (const g of basemap.ground)
    L.polygon(g.ring.map(ll), { pane: 'ground', stroke: false, fillColor: GROUND_FILL[g.kind], fillOpacity: 0.8, interactive: false }).addTo(groundLayer);
  for (const s of basemap.lines) {
    const pts = s.pts.map(ll);
    const klass = s.klass as LineClass;
    // footways read better as a single dashed line, with no casing under them
    const casing = klass === 'walk' ? null
      : L.polyline(pts, { pane: 'casing', interactive: false, color: LINE_CASE[klass], weight: 1, lineCap: 'round', lineJoin: 'round' }).addTo(groundLayer);
    const fill = L.polyline(pts, { pane: 'base', interactive: false, color: LINE_FILL[klass], weight: 1, lineCap: klass === 'walk' ? 'butt' : 'round', lineJoin: 'round' }).addTo(groundLayer);
    baseLines.push({ fill, casing, klass });
  }
  // one name label per street, on its longest way, like a printed map
  const longest = new Map<string, { len: number; pts: [number, number][] }>();
  for (const s of basemap.lines) {
    if (!s.name || s.klass === 'walk') continue;
    let len = 0;
    for (let i = 1; i < s.pts.length; i++) len += Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y);
    const cur = longest.get(s.name);
    if (!cur || len > cur.len) longest.set(s.name, { len, pts: s.pts.map(ll) });
  }
  for (const [name, v] of longest) {
    if (v.len < 40) continue;
    L.polyline(v.pts, { pane: 'label', interactive: false, opacity: 0 })
      .bindTooltip(name, { permanent: true, direction: 'center', className: 'st', pane: 'label' })
      .addTo(labelLayer);
  }
  applyLineWeights();
  syncLabels();
}

// The walkable-network overlay is thousands of polylines; build it only when first shown.
let netBuilt = false;
function buildNet() {
  if (netBuilt || !model) return;
  netBuilt = true;
  for (const e of model.edges) {
    const A = ll(model.nodes[e.a]), B = ll(model.nodes[e.b]);
    const st = e.kind === 'outdoor'
      ? { color: e.connector ? '#CEB888' : '#8B8D8E', weight: 1.2, opacity: 0.7 }
      : { color: '#8E6F3E', weight: 2, dashArray: '4 4', opacity: 0.9 };
    L.polyline([A, B], { pane: 'net', ...st }).addTo(netLayer);
  }
}

/** Leaflet fills a multi-ring path with one rule, so rings must wind alike or
    nonzero cancels them. Returns rings ready for a single L.polygon. */
function multiRings(rings: XY[][]): [number, number][][][] {
  return rings.map((r) => {
    const pts = r.map(ll);
    let twiceArea = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      twiceArea += p[0] * q[1] - q[0] * p[1];
    }
    return [twiceArea < 0 ? pts.reverse() : pts];
  });
}

function drawModel() {
  if (!model) return;
  bldLayer.clearLayers(); treeLayer.clearLayers(); tunnelLayer.clearLayers(); netLayer.clearLayers();
  doorLayer.clearLayers(); crossLayer.clearLayers(); doorsBuilt = false; crossBuilt = false;
  netBuilt = false; namedPolys = []; labelsBound = false;
  for (const b of model.buildings) {
    // Off-campus buildings are scenery: muted, unlabeled, clicks fall through to the map.
    const poly = L.polygon(b.ring.map(ll), b.campus
      ? { color: '#A79470', weight: 1, fillColor: '#E0D6BE', fillOpacity: 0.85, bubblingMouseEvents: false }
      : { color: '#B4AFA3', weight: 0.8, fillColor: '#E4E1D9', fillOpacity: 0.6, interactive: false }).addTo(bldLayer);
    if (b.campus && b.named) namedPolys.push({ poly, abbr: b.abbr, id: b.id });
    if (b.campus) poly.on('click', () => { if (b.named) askPlace({ kind: 'building', id: b.id, label: `${b.abbr}  ${b.name}` }, ll(b.c)); });
    bldShapes[b.id] = poly;
  }
  // Tunnels and skywalks are invisible on any basemap, so draw the network
  // itself: a dashed line you can see before a route ever uses it.
  for (const e of model.edges) {
    if (e.kind !== 'link' || (e.linkKind !== 'subwalk' && e.linkKind !== 'skywalk')) continue;
    const A = ll(model.nodes[e.a]), B = ll(model.nodes[e.b]);
    const under = e.linkKind === 'subwalk';
    L.polyline([A, B], {
      pane: 'net', color: under ? '#6F5A2E' : '#8E6F3E', weight: 3,
      opacity: under ? 0.55 : 0.7, dashArray: under ? '2 7' : '9 5', lineCap: 'round',
    }).addTo(tunnelLayer).bindTooltip(
      `${under ? 'Tunnel' : 'Skywalk'}${e.bldA && e.bldB ? `: ${model.byId[e.bldA].abbr} – ${model.byId[e.bldB].abbr}` : ''}${e.verified === false ? ' (unverified)' : ''}`,
      { sticky: true, className: 'st' });
  }

  // Thousands of separate circle layers made panning crawl on a phone; one
  // multipolygon is a single canvas path and overlaps read as one flat tone.
  if (model.trees.length)
    L.polygon(multiRings(model.trees.map((t) => t.ring)), {
      pane: 'ground', stroke: false, fillColor: '#C6CEB4', fillOpacity: 0.75,
      fillRule: 'nonzero', interactive: false,
    }).addTo(treeLayer);
}

map.on('click', (e) => {
  const p = pointAt(e.latlng);
  if (p) askPlace(p, [p.lat, p.lon]);
  else if (model) toast('No mapped path there. Tap a sidewalk, a path, or a campus building.');
});

/** A tap is ambiguous, so never guess: ask at the point which end it is. */
function askPlace(pl: Place, at: [number, number]) {
  if (pendingField) { setPlace(pl, pendingField); return; } // the user already picked a field
  const el = document.createElement('div');
  el.className = 'pk';
  const primary = origin && !dest ? 'to' : 'from';
  const btn = (f: 'from' | 'to', ic: string, label: string) =>
    `<button data-f="${f}"${f === primary ? ' class="p"' : ''}>${icon(ic, 15)}${label}</button>`;
  el.innerHTML = `<b>${esc(pl.label)}</b><div class="pkb">${
    btn('from', 'start', origin ? 'Change start' : 'Start here')}${
    btn('to', 'arrive', dest ? 'Change end' : 'End here')}</div>`;
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    map.closePopup();
    setPlace(pl, b.dataset.f as 'from' | 'to');
  }));
  L.popup({ className: 'pkpop', closeButton: false, offset: [0, -4], autoPanPadding: [24, 100] })
    .setLatLng(at).setContent(el).openOn(map);
}
function pointAt(latlng: { lat: number; lng: number }): Extract<Place, { kind: 'point' }> | null {
  if (!model) return null;
  const p = proj.xy(latlng.lat, latlng.lng);
  const near = nearestPathNode(model, p);
  if (!near || near.d > PIN_CONNECT) return null;
  const n = near.node;
  const nm = (model.adj[n.id].find((e) => e.name && !e.connector) || {} as Edge).name;
  const [lat, lon] = ll(n);
  return { kind: 'point', nodeId: n.id, lat, lon, label: nm ? `Pin near ${nm}` : 'Dropped pin' };
}
const pinIcon = (cls: string) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><i></i></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
function drawPins() {
  pinLayer.clearLayers();
  if (!model) return;
  for (const [pl, cls, field] of [[origin, 'o', 'from'], [dest, 'd', 'to']] as [Place | null, string, 'from' | 'to'][]) {
    if (!pl) continue;
    const c = pl.kind === 'building' ? ll(model.byId[pl.id].c) : [pl.lat, pl.lon] as [number, number];
    const m = L.marker(c, { icon: pinIcon(cls), draggable: true, pane: 'routes', bubblingMouseEvents: false }).addTo(pinLayer);
    m.on('dragend', () => { const p = pointAt(m.getLatLng()); if (p) setPlace(p, field); else drawPins(); });
  }
}

/* ================= status / errors ================= */
// Once the app is running, status goes to a toast that stays visible whatever the
// sheet is doing (a collapsed sheet used to swallow GPS errors silently).
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastT: number | undefined;
function toast(html: string) {
  toastEl.innerHTML = html;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => toastEl.classList.remove('show'), 7000);
}
toastEl.onclick = () => toastEl.classList.remove('show');
function setStatus(msg: string) {
  if (model) toast(msg);
  else $('loadbox').innerHTML = `<p class="status">${msg}</p>`;
}
/** The data arrived but rendering it threw: say so, rather than blaming Overpass. */
function showFatal(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  $('loadbox').innerHTML = `<div class="err"><b>The map data loaded, but drawing it failed.</b><br><small>${esc(message)}</small><br><br>
  This is a bug in the app rather than a problem with the data. Reloading may clear it.
  <div class="btnrow"><button class="btn" id="reloadbtn">Reload</button></div></div>`;
  $('reloadbtn').onclick = () => location.reload();
}

function showError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  $('loadbox').innerHTML = `<div class="err"><b>Could not load OpenStreetMap data.</b><br><small>${esc(message)}</small><br><br>
  Overpass servers rate-limit repeated requests. Fastest fix: load a file you saved earlier. Otherwise wait a minute and retry, or run the query at overpass-turbo.eu, choose Export, download JSON, and load it here.
  <div class="btnrow"><label class="btn" style="display:inline-block">Load saved data<input type="file" id="jsonfile" accept="application/json,.json" style="display:none"></label><button class="btn quiet" id="retry">Retry</button><button class="btn quiet" id="copyq">Copy query</button></div>
  <code>${esc(overpassQuery(BBOX))}</code></div>`;
  $('copyq').onclick = () => navigator.clipboard?.writeText(overpassQuery(BBOX));
  $('retry').onclick = () => void boot(true);
  loadFile($<HTMLInputElement>('jsonfile'));
}
function saveOsm() {
  if (!rawOsm) return;
  const data = { ...rawOsm, _fetched: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'boiler-route-data.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function loadFile(input: HTMLInputElement) {
  input.onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { start(JSON.parse(await f.text()), 'from a saved file'); } catch (e) { showError(e); }
  };
}

/* ================= search fields ================= */
function suggestions(q: string) {
  if (!model) return [];
  q = q.trim().toLowerCase();
  const named = model.buildings.filter((b) => b.named && b.campus);
  const score = (b: typeof named[0]): number | null => {
    const ab = b.abbr.toLowerCase(), nm = b.name.toLowerCase();
    if (!q) return 5;
    if (ab === q) return 0;
    if (ab.startsWith(q)) return 1;
    if (nm.startsWith(q)) return 2;
    if (nm.split(/\s+/).some((w) => w.startsWith(q))) return 3;
    if (nm.includes(q) || ab.includes(q)) return 4;
    return null;
  };
  return named.map((b) => ({ b, s: score(b) })).filter((x) => x.s !== null)
    .sort((a, b) => a.s! - b.s! || a.b.name.localeCompare(b.b.name)).slice(0, 8).map((x) => x.b);
}
function renderSugg(field: 'from' | 'to') {
  const box = $(field + '-sugg'), q = ($(field) as HTMLInputElement).value;
  const list = suggestions(q);
  box.innerHTML = list.map((b) => `<button type="button" data-id="${b.id}"><span class="ab">${esc(b.abbr)}</span><span class="nm">${esc(b.name)}</span></button>`).join('') +
    `<button type="button" data-act="map"><span class="ab act">Map</span><span class="nm">Choose a point on the map</span></button>` +
    (field === 'from' ? `<button type="button" data-act="loc"><span class="ab act">GPS</span><span class="nm">Use my location</span></button>` : '');
  box.classList.add('open');
  box.querySelectorAll('button').forEach((btn) => (btn.onmousedown = (ev) => {
    ev.preventDefault();
    const id = (btn as HTMLElement).dataset.id, act = (btn as HTMLElement).dataset.act;
    if (id && model) { const b = model.byId[id]; setPlace({ kind: 'building', id: b.id, label: `${b.abbr}  ${b.name}` }, field); }
    else if (act === 'map') {
      pendingField = field;
      ($(field) as HTMLInputElement).value = '';
      ($(field) as HTMLInputElement).placeholder = 'Now tap the map';
      closeSugg();
      toast(`Tap the map to set the ${field === 'from' ? 'starting point' : 'destination'}.`);
    }
    else if (act === 'loc') { locate(); closeSugg(); }
  }));
}
function closeSugg() { document.querySelectorAll('.sugg').forEach((s) => s.classList.remove('open')); }
for (const f of ['from', 'to'] as const) {
  const inp = $<HTMLInputElement>(f);
  inp.addEventListener('focus', () => { if (model) { inp.select(); renderSugg(f); if (isMobile()) setSheet('peek'); } });
  inp.addEventListener('input', () => renderSugg(f));
  inp.addEventListener('blur', () => setTimeout(closeSugg, 120));
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = $(f + '-sugg').querySelector<HTMLButtonElement>('button[data-id]');
      if (first) first.onmousedown!(ev as unknown as MouseEvent);
      inp.blur();
    }
    if (ev.key === 'Escape') inp.blur();
  });
}
document.querySelectorAll<HTMLButtonElement>('.clear').forEach((b) => (b.onclick = () => {
  const f = b.dataset.for as 'from' | 'to';
  if (f === 'from') origin = null; else dest = null;
  const inp = $<HTMLInputElement>(f);
  inp.value = ''; inp.placeholder = f === 'from' ? 'Choose starting point' : 'Choose destination';
  $('f-' + f).classList.remove('has');
  pendingField = null;
  drawPins(); routeLayer.clearLayers(); update();
}));
function setPlace(place: Place, field?: 'from' | 'to') {
  if (!field) {
    if (!origin && !dest) field = 'from';
    else if (origin && !dest) field = 'to';
    else if (!origin && dest) field = 'from';
    else field = pendingField || 'to';
  }
  pendingField = null;
  if (field === 'from') origin = place; else dest = place;
  if (place.kind === 'building' && model) {
    const b = model.byId[place.id];
    setStatus(`<b>${esc(b.name)}</b>: ${b.doorsTagged} tagged entrance${b.doorsTagged === 1 ? '' : 's'}${b.doorsAssumed ? `, ${b.doorsAssumed} assumed` : ''}${b.doorsSkipped.length ? `, ${b.doorsSkipped.length} unusable (${[...new Set(b.doorsSkipped)].join(', ')})` : ''}; height ${fmtHeight(b.height, units())} (${b.heightSource === 'lidar' ? 'lidar' : b.heightSource === 'osm' ? 'OSM' : 'assumed'}); hours ${fmtHours(b.hours)} ${b.hoursTagged ? '(OSM)' : '(assumed)'}.`);
  }
  const inp = $<HTMLInputElement>(field);
  inp.value = place.label;
  inp.placeholder = field === 'from' ? 'Choose starting point' : 'Choose destination';
  $('f-' + field).classList.add('has');
  inp.blur();
  drawPins(); update();
}
$('swap').onclick = () => {
  [origin, dest] = [dest, origin];
  for (const [f, p] of [['from', origin], ['to', dest]] as ['from' | 'to', Place | null][]) {
    ($(f) as HTMLInputElement).value = p ? p.label : '';
    $('f-' + f).classList.toggle('has', !!p);
  }
  drawPins(); update();
};
/* live GPS: blue dot + accuracy ring, kept fresh while the app is open */
let watchId: number | null = null;
let locDot: L.CircleMarker | null = null;
let locRing: L.Circle | null = null;
let lastFix: { lat: number; lon: number } | null = null;
/**
 * Advance along the route as the fix moves: drop what has been walked, move the
 * banner to the step you are on, and count the route down instead of up. If the
 * fix leaves the route for several fixes in a row, route again from where you
 * actually are, which is what walking past a turn should do.
 */
function followFix(lat: number, lon: number) {
  if (!model || !lastRoutes || !shownLegs.length) return;
  const p = proj.xy(lat, lon);
  const pr = progressOn(shownLegs, p);
  if (!pr) return;

  if (pr.off > REROUTE_M) {
    // only reroute for someone who was actually walking this route
    if (!following) return;
    if (++offFixes < REROUTE_FIXES) return;
    offFixes = 0; following = false; doneAlong = 0;
    const near = pointAt({ lat, lng: lon });
    if (!near) { toast('You are off the route and away from any mapped path.'); return; }
    toast('Off the route — finding a new one from where you are.');
    near.label = 'My location';
    setPlace(near, 'from');
    return;
  }
  offFixes = 0;
  if (pr.off > FOLLOW_M) return;   // near enough to show, not near enough to follow
  following = true;
  // never walk the route backwards on a noisy fix
  if (pr.along <= doneAlong) return;
  doneAlong = pr.along;

  paintRoute(lastRoutes.ctx, null);
  // the current step is the last turn you have passed
  let i = 0;
  while (i + 1 < stepAlong.length && stepAlong[i + 1] <= doneAlong + 1) i++;
  if (i !== navI) { navI = i; renderNav(); }
  const left = remainingTime(shownLegs, doneAlong, (e) => edgeTime(e, lastRoutes!.ctx));
  const arrive = fmtClock((lastRoutes.ctx.mins + Math.round(left / 60)) % 1440);
  setTrip(`<b>${fmtMin(left)} left</b> · ${dist(pr.total - doneAlong)} · arrive ${arrive}`);
}

function showFix(lat: number, lon: number, acc: number) {
  lastFix = { lat, lon };
  try { localStorage.setItem('geoOk', '1'); } catch { /* private mode */ }
  if (!locDot) {
    locRing = L.circle([lat, lon], { pane: 'gps', radius: acc, color: '#1F5FBF', weight: 1, opacity: 0.4, fillColor: '#1F5FBF', fillOpacity: 0.08, interactive: false }).addTo(map);
    locDot = L.circleMarker([lat, lon], { pane: 'gps', radius: 7, color: '#fff', weight: 2.5, fillColor: '#1F5FBF', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    locDot.setLatLng([lat, lon]);
    locRing!.setLatLng([lat, lon]).setRadius(acc);
  }
  followFix(lat, lon);
}
function startWatch() {
  if (watchId !== null || !navigator.geolocation || !window.isSecureContext) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => showFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}
function geoReady(): boolean {
  if (!navigator.geolocation) { setStatus('This browser has no location access.'); return false; }
  if (!window.isSecureContext) {
    setStatus('Location needs a secure page: browsers only allow GPS over <b>https://</b> (or on localhost). Open the <b>https://</b> address of this app (dev: <code>npm run dev:https</code>), accepting the certificate warning once.');
    return false;
  }
  return true;
}
const geoError = (err: GeolocationPositionError) =>
  setStatus('Location unavailable: ' + esc(err.message) +
    (err.code === 1
      ? '. On iPhone: Settings → Privacy &amp; Security → Location Services → Safari Websites → “While Using”, then reload and allow the prompt.'
      : '. Try tapping the map instead.'));

/** Floating GPS button: show/centre the blue dot without touching the route. */
function showMyLocation() {
  if (!geoReady()) return;
  if (lastFix) map.setView([lastFix.lat, lastFix.lon], Math.max(map.getZoom(), 17));
  else setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition((pos) => {
    showFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    startWatch();
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 17));
  }, geoError, { enableHighAccuracy: true, timeout: 10000 });
}

/** "Use my location": same, but also sets the starting point. */
function locate() {
  if (!geoReady()) return;
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    showFix(lat, lon, accuracy);
    startWatch();
    const margin = 0.004;
    if (lat < BBOX[0] - margin || lat > BBOX[2] + margin || lon < BBOX[1] - margin || lon > BBOX[3] + margin) {
      setStatus('You are outside the study area. Widen BBOX in src/constants.ts to include where you are.');
      return;
    }
    const p = pointAt({ lat, lng: lon });
    if (p) { p.label = 'My location'; setPlace(p, 'from'); } else setStatus('No mapped path near your location.');
  }, geoError, { enableHighAccuracy: true, timeout: 10000 });
}
$('locate').onclick = locate;

const locBtn = document.createElement('button');
locBtn.id = 'locbtn';
locBtn.setAttribute('aria-label', 'Show my location');
locBtn.innerHTML = icon('crosshair', 21);
document.body.appendChild(locBtn);
locBtn.onclick = showMyLocation;

// If GPS was granted on a previous visit, resume the live dot quietly.
try { if (localStorage.getItem('geoOk') && window.isSecureContext) startWatch(); } catch { /* private mode */ }
$('share').onclick = () => {
  writeHash();
  navigator.clipboard?.writeText(location.href).then(() => {
    $('sharelbl').textContent = 'Copied';
    setTimeout(() => ($('sharelbl').textContent = 'Copy link'), 1500);
  });
};
const placeKey = (p: Place | null): string => (p ? (p.kind === 'building' ? p.id : `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`) : '');
function writeHash() {
  history.replaceState(null, '', `#o=${placeKey(origin)}&d=${placeKey(dest)}&t=${($('time') as HTMLInputElement).value}&c=${($('comfort') as HTMLInputElement).value}`);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const parse = (v: string | null): Place | null => {
    if (!v || !model) return null;
    if (model.byId[v]) { const b = model.byId[v]; return { kind: 'building', id: b.id, label: `${b.abbr}  ${b.name}` }; }
    const m = v.match(/^(-?[\d.]+),(-?[\d.]+)$/);
    if (m) return pointAt({ lat: +m[1], lng: +m[2] });
    return null;
  };
  const o = parse(q.get('o')), d = parse(q.get('d'));
  if (q.get('t')) ($('time') as HTMLInputElement).value = q.get('t')!;
  if (q.get('c')) ($('comfort') as HTMLInputElement).value = q.get('c')!;
  if (o) setPlace(o, 'from');
  if (d) setPlace(d, 'to');
}
/* ================= bottom sheet: peek / half / full ================= */
type SheetPos = 'peek' | 'half' | 'full';
const sheetEl = $('sheet'), sheetc = $('sheetc');
const isMobile = () => window.innerWidth < 820;
let sheetPos: SheetPos = 'half';
// measures env(safe-area-inset-bottom) so the peek bar clears the home indicator
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);pointer-events:none;visibility:hidden';
document.body.appendChild(safeProbe);
function visFor(p: SheetPos): number {
  if (p === 'full') return sheetEl.getBoundingClientRect().height;
  if (p === 'half') return Math.min(window.innerHeight * 0.5, 430);
  // measured, not hardcoded: everything above the trip bar plus the bar itself
  const tb = $('tripbar');
  return tb.offsetTop + tb.offsetHeight + safeProbe.offsetHeight;
}
function applySheet() {
  sheetEl.dataset.pos = sheetPos;
  sheetEl.style.transform = isMobile()
    ? `translateY(${sheetEl.getBoundingClientRect().height - visFor(sheetPos)}px)` : '';
}
function setSheet(p: SheetPos) { sheetPos = p; applySheet(); }
function setTrip(html: string) { $('tripmain').innerHTML = html; }
{
  let y0 = 0, off0 = 0, cur = 0, lastY = 0, lastT = 0, vy = 0;
  let dragging = false, fromContent = false;
  sheetEl.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    y0 = lastY = e.touches[0].clientY; lastT = e.timeStamp; vy = 0;
    off0 = cur = sheetEl.getBoundingClientRect().height - visFor(sheetPos);
    dragging = false;
    fromContent = sheetc.contains(e.target as Node);
  }, { passive: true });
  sheetEl.addEventListener('touchmove', (e) => {
    if (!isMobile()) return;
    const y = e.touches[0].clientY, dy = y - y0;
    if (!dragging) {
      // in the full state the content owns upward drags and any drag while scrolled
      if (sheetPos === 'full' && fromContent && (sheetc.scrollTop > 0 || dy < 0)) return;
      if (Math.abs(dy) < 6) return;
      dragging = true;
      sheetEl.classList.add('drag');
    }
    e.preventDefault();
    const H = sheetEl.getBoundingClientRect().height;
    cur = Math.min(Math.max(off0 + dy, H - visFor('full')), H - visFor('peek'));
    sheetEl.style.transform = `translateY(${cur}px)`;
    if (e.timeStamp > lastT) vy = (y - lastY) / (e.timeStamp - lastT);
    lastY = y; lastT = e.timeStamp;
  }, { passive: false });
  sheetEl.addEventListener('touchend', (e) => {
    if (!dragging) return;
    e.preventDefault(); // no synthetic click after a drag
    dragging = false;
    sheetEl.classList.remove('drag');
    const vis = sheetEl.getBoundingClientRect().height - cur;
    let best: SheetPos = 'peek', bd = Infinity;
    for (const p of ['peek', 'half', 'full'] as SheetPos[]) {
      const d = Math.abs(visFor(p) - vis);
      if (d < bd) { bd = d; best = p; }
    }
    // a fling overrides the nearest snap
    if (vy > 0.35) best = vis > visFor('half') ? 'half' : 'peek';
    else if (vy < -0.35) best = vis < visFor('half') ? 'half' : 'full';
    setSheet(best);
  });
  $('handle').onclick = () => setSheet(sheetPos === 'peek' ? 'half' : 'peek');
  $('tripbar').onclick = () => setSheet(sheetPos === 'peek' ? 'half' : sheetPos === 'half' ? 'full' : 'peek');
  window.addEventListener('resize', () => { applySheet(); syncMini(); });
  applySheet();
}

/* collapsed search bar: one compact row once both ends are set (phones) */
function syncMini() {
  if (!isMobile() || !origin || !dest) { $('search').classList.remove('mini'); return; }
  const short = (p: Place) => p.kind === 'building' && model ? model.byId[p.id].abbr : p.label === 'My location' ? 'Me' : 'Pin';
  $('minibar').innerHTML = `${esc(short(origin))} <small>→</small> ${esc(short(dest))} <span class="edit">edit</span>`;
  $('search').classList.add('mini');
}
$('minibar').onclick = () => { $('search').classList.remove('mini'); syncTop(); };

/* ================= directions banner (always visible above the map) ================= */
type Step = ReturnType<typeof directions>[number];
let navSteps: Step[] = [], navI = 0;
const maneuverSvg = (m: string) => icon(m === 'link' ? 'bridge' : m, 21);
const topEl = $('top');
function syncTop() { document.documentElement.style.setProperty('--toph', topEl.offsetHeight + 'px'); }
new ResizeObserver(syncTop).observe(topEl);
function renderNav() {
  const nav = $('nav');
  if (!navSteps.length) {
    nav.hidden = true;
    if (turnDot) { map.removeLayer(turnDot); turnDot = null; }
    return;
  }
  nav.hidden = false;
  navI = Math.min(Math.max(navI, 0), navSteps.length - 1);
  const s = navSteps[navI];
  $('navic').className = 'mic ' + s.icon;
  $('navic').innerHTML = maneuverSvg(s.maneuver);
  $('navtext').textContent = s.text;
  $('navsub').textContent = `${navI + 1}/${navSteps.length}${s.sub ? ' · ' + s.sub : ''} · tap to see the turn`;
  $('navm').textContent = dist(s.m);
  ($('navprev') as HTMLButtonElement).disabled = navI === 0;
  ($('navnext') as HTMLButtonElement).disabled = navI === navSteps.length - 1;
  $('steps').querySelectorAll('li').forEach((li) => li.setAttribute('aria-current', String(+li.dataset.i! === navI)));
}
let turnDot: L.CircleMarker | null = null;
function goStep(i: number) {
  navI = i;
  renderNav();
  const s = navSteps[navI];
  if (!s) return;
  const c = ll(s.at);
  map.setView(c, Math.max(map.getZoom(), 18), { animate: true });
  if (!turnDot) turnDot = L.circleMarker(c, { pane: 'routes', radius: 9, color: '#191817', weight: 3, fillColor: '#FCFBF7', fillOpacity: 1, interactive: false }).addTo(map);
  else turnDot.setLatLng(c);
}
$('navprev').onclick = () => goStep(navI - 1);
$('navnext').onclick = () => goStep(navI + 1);
// tapping the step flies to that turn and drops a marker on it
$('navmain').onclick = () => goStep(navI);
$('navlist').onclick = () => {
  const list = $('steps'), open = list.hidden;
  list.hidden = !open;
  $('navlist').setAttribute('aria-expanded', String(open));
  if (open) list.querySelector('li[aria-current=true]')?.scrollIntoView({ block: 'center' });
};

/* ================= sheet tabs ================= */
$('tabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
  for (const o of $('tabs').querySelectorAll('button')) o.setAttribute('aria-selected', String(o === b));
  for (const t of ['route', 'cond', 'layers', 'data']) ($('tab-' + t) as HTMLElement).hidden = t !== b.dataset.tab;
  if (isMobile() && sheetPos === 'peek') setSheet('half');
}));

/* ================= conditions ================= */
// Dragging a slider updates the readout every frame but defers the routing pass,
// so the thumb never waits on a recompute; releasing it recomputes at once.
for (const id of ['date', 'tempn', 'wind', 'cloud', 'precip', 'time', 'comfort', 'manual', 'stepfree', 'nojaywalk', 'crossbld', 'units']) {
  $(id).addEventListener('input', () => scheduleUpdate(false));
  $(id).addEventListener('change', () => scheduleUpdate(true));
}
function applyBasemap() {
  const v = ($('basemap') as HTMLSelectElement).value;
  if (v === 'tiles') tiles.addTo(map); else map.removeLayer(tiles);
  drawBasemap();
}
$('basemap').addEventListener('change', applyBasemap);
$('units').addEventListener('change', () => { try { localStorage.setItem('units', units()); } catch { /* private mode */ } });
try { const u = localStorage.getItem('units'); if (u) ($('units') as HTMLSelectElement).value = u; } catch { /* private mode */ }
/* ================= layer switches ================= */
const LAYER_LEGEND: Record<string, [string, string][]> = {
  lyDoor: [['#1F5FBF', 'tagged in OSM'], ['#C77B1F', 'assumed from the walls'], ['#2E7D32', 'inside corridor']],
  lyCross: [['#1F5FBF', 'signal'], ['#2E7D32', 'marked'], ['#C77B1F', 'unmarked'], ['#B3352C', 'no crossing mapped']],
  lyHeights: [['#CBB98A', 'lidar'], ['#B9C4CF', 'OSM height tag'], ['#E6E2D6', 'assumed']],
};
function syncLayerLegend() {
  const on = Object.keys(LAYER_LEGEND).filter((id) => ($(id) as HTMLInputElement)?.checked);
  const box = $('lyLegend');
  box.hidden = !on.length;
  box.innerHTML = on.flatMap((id) => LAYER_LEGEND[id].map(([c, t]) => `<div><i style="background:${c}"></i>${t}</div>`)).join('');
}
/** A switch either toggles a map layer or flips a flag and redraws. */
const LAYERS: Record<string, (on: boolean) => void> = {
  lyBld: (on) => (on ? bldLayer.addTo(map) : map.removeLayer(bldLayer)),
  lyLabel: (on) => { wantBldLabels = on; labelsBound = !on; syncBuildingLabels(); },
  lyTree: (on) => (on ? treeLayer.addTo(map) : map.removeLayer(treeLayer)),
  lyShadow: (on) => (on ? shadowLayer.addTo(map) : map.removeLayer(shadowLayer)),
  lyTunnel: (on) => (on ? tunnelLayer.addTo(map) : map.removeLayer(tunnelLayer)),
  lyStreet: (on) => { wantStreetNames = on; syncLabels(); },
  lyBounds: (on) => (on ? boundsRect.addTo(map) : map.removeLayer(boundsRect)),
  shownet: (on) => { if (on) { buildNet(); netLayer.addTo(map); } else map.removeLayer(netLayer); },
  lyDoor: (on) => { if (on) { buildDoors(); doorLayer.addTo(map); } else map.removeLayer(doorLayer); },
  lyCross: (on) => { if (on) { buildCrossings(); crossLayer.addTo(map); } else map.removeLayer(crossLayer); },
  lyHeights: (on) => { reviewHeights = on; openKey = ''; update(); },
};
for (const id of Object.keys(LAYERS)) {
  const box = $(id) as HTMLInputElement;
  box.addEventListener('change', () => {
    LAYERS[id](box.checked);
    syncLayerLegend();
    try { localStorage.setItem('ly:' + id, box.checked ? '1' : '0'); } catch { /* private mode */ }
  });
  try {
    const saved = localStorage.getItem('ly:' + id);
    if (saved !== null) box.checked = saved === '1';
  } catch { /* private mode */ }
}
/** Apply the saved switches, and show how much each layer is drawing. */
function applyLayers() {
  for (const id of Object.keys(LAYERS)) LAYERS[id](($(id) as HTMLInputElement).checked);
  syncLayerLegend();
  if (!model) return;
  const set = (id: string, n: number) => ($(id).textContent = String(n));
  set('cBld', model.buildings.length);
  set('cTree', model.trees.length);
  set('cTunnel', model.edges.filter((e) => e.kind === 'link' && (e.linkKind === 'subwalk' || e.linkKind === 'skywalk')).length);
  set('cNet', model.edges.length);
  set('cDoor', [...model.doorsOf.values()].reduce((n, d) => n + d.size, 0));
  set('cCross', model.edges.filter((e) => e.crossing).length);
}
function nearestOption(sel: HTMLSelectElement, v: number) {
  let best: string | null = null, bd = 1e9;
  for (const o of sel.options) { const d = Math.abs(+o.value - v); if (d < bd) { bd = d; best = o.value; } }
  if (best !== null) sel.value = best;
}
function conditions(): { tempF: number; wind: Wind; cloud: number; precipMm: number } {
  const manual = ($('manual') as HTMLInputElement).checked;
  const mins = +($('time') as HTMLInputElement).value;
  const dateStr = ($('date') as HTMLInputElement).value;
  for (const id of ['tempn', 'wind', 'cloud', 'precip']) ($(id) as HTMLSelectElement).disabled = !manual;
  const w = weatherAt(wx, dateStr, mins);
  if (!manual && w) {
    nearestOption($('tempn') as HTMLSelectElement, w.tempF);
    ($('wind') as HTMLSelectElement).value = windClass(w.mph);
    nearestOption($('cloud') as HTMLSelectElement, w.cloud);
    nearestOption($('precip') as HTMLSelectElement, w.precipMm);
    $('wx').innerHTML = `Live for ${fmtClock(mins)}: <b>${Math.round(w.tempF)} °F</b>, wind ${Math.round(w.mph)} mph, ${Math.round(w.cloud)}% cloud${w.precipMm > 0 ? `, ${w.precipMm.toFixed(1)} mm/h rain` : ''} <small>(Open-Meteo, fetched ${wx.fetchedAt!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})</small>`;
    return { tempF: w.tempF, wind: windClass(w.mph), cloud: w.cloud, precipMm: w.precipMm };
  }
  if (!manual) $('wx').innerHTML = wx.ok
    ? 'No forecast for that date and time (Open-Meteo covers about 3 days). Using the manual values below.'
    : wx.err ? `Live weather unavailable (${esc(wx.err)}). Using the manual values below.` : 'Fetching live weather…';
  else $('wx').innerHTML = 'Manual conditions.';
  return {
    tempF: +($('tempn') as HTMLSelectElement).value, wind: ($('wind') as HTMLSelectElement).value as Wind,
    cloud: +($('cloud') as HTMLSelectElement).value, precipMm: +($('precip') as HTMLSelectElement).value,
  };
}

/* ================= update + render ================= */
/**
 * Shade is the expensive part (every caster ray-traced against every outdoor
 * edge) and depends only on the sun, so it is cached by date and minute. The
 * comfort slider changes neither, and must never pay for it.
 */
let shadeCache: { key: string; sun: ReturnType<typeof sunPosition>; sunFrac: Float32Array; shadows: XY[][] } | null = null;
let shadowKey = '', openKey = '';
function shadeAt(date: Date, key: string) {
  if (shadeCache?.key === key) return shadeCache;
  const sun = sunPosition(date, CAMPUS.lat, CAMPUS.lon);
  const { sunFrac, shadows } = computeShade(model!, sun);
  shadeCache = { key, sun, sunFrac, shadows };
  return shadeCache;
}

/** Cheap enough to run on every frame of a drag: just the readouts. */
function updateLabels() {
  const mins = +($('time') as HTMLInputElement).value;
  const w = +($('comfort') as HTMLInputElement).value / 100;
  ($('timeout') as HTMLOutputElement).value = fmtClock(mins);
  ($('comfortout') as HTMLOutputElement).value = w === 0 ? 'Fastest' : `${Math.round(w * 100)}%`;
  ($('comfort') as HTMLInputElement).style.setProperty('--fill', `${w * 100}%`);
  ($('time') as HTMLInputElement).style.setProperty('--fill', `${(mins / 1425) * 100}%`);
}

/** Recompute after the drag settles, so a slider never blocks on routing. */
let heavyT: number | undefined;
function scheduleUpdate(now = false) {
  updateLabels();
  clearTimeout(heavyT);
  if (now) { update(); return; }
  document.body.classList.add('recalc');
  heavyT = window.setTimeout(update, isMobile() ? 170 : 60);
}

function update() {
  raf = null;
  clearTimeout(heavyT);
  document.body.classList.remove('recalc');
  if (!model) return;
  const mins = +($('time') as HTMLInputElement).value;
  const w = +($('comfort') as HTMLInputElement).value / 100;
  const cond = conditions();
  const tempF = cond.tempF;
  updateLabels();
  const dateStr = ($('date') as HTMLInputElement).value || todayISO();
  const date = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return; // half-typed date: wait for a real one
  date.setMinutes(mins);
  const shadeKey = `${dateStr}|${mins}`;
  const { sun, sunFrac, shadows } = shadeAt(date, shadeKey);
  const sunAddF = Math.round(SUN_MAX_C * Math.max(0, Math.sin(sun.alt)) * (1 - (CLOUD_CUT * cond.cloud) / 100) * 9 / 5);
  $('condcur').textContent = `${fmtClock(mins)}, ${Math.round(tempF)} °F${sunAddF ? `, sun +${sunAddF} °F` : ''}`;
  $('suntext').lastElementChild!.textContent = sun.alt <= 0 ? 'Night' : `Sun ${Math.round((sun.alt * 180) / Math.PI)}° ${compassShort(sun.bearing)}, +${sunAddF} °F`;
  // Shadows only move when the sun does, so skip the rebuild when the time did not change.
  // One multipolygon = one canvas path: much cheaper than hundreds of layers, and
  // overlapping shadows read as one flat tone instead of double-darkening.
  // That single path needs the nonzero fill rule (Leaflet defaults to evenodd,
  // which punches overlaps back out) and rings wound the same way, or opposite
  // windings cancel under nonzero too.
  if (shadowKey !== shadeKey) {
    shadowKey = shadeKey;
    shadowLayer.clearLayers();
    if (shadows.length) {
      const rings = shadows.map((h) => {
        const pts = h.map(ll);
        let twiceArea = 0;
        for (let i = 0, n = pts.length; i < n; i++) {
          const p = pts[i], q = pts[(i + 1) % n];
          twiceArea += p[0] * q[1] - q[0] * p[1];
        }
        return [twiceArea < 0 ? pts.reverse() : pts];
      });
      L.polygon(rings, { pane: 'shadow', stroke: false, fillColor: '#191817', fillOpacity: 0.16, fillRule: 'nonzero', interactive: false }).addTo(shadowLayer);
    }
  }

  const open = computeOpen(model.buildings, date.getDay(), mins / 60);
  // Open/closed styling also only changes with the clock.
  if (openKey !== shadeKey) {
    openKey = shadeKey;
    lastOpen = open;
    for (const b of model.buildings) {
      if (!b.campus) continue; // scenery keeps its muted style
      bldShapes[b.id]?.setStyle(reviewHeights
        ? { fillColor: HEIGHT_COLOR[b.heightSource], dashArray: undefined }
        : { fillColor: open[b.id] ? '#E0D6BE' : '#E9E5D9', dashArray: open[b.id] ? undefined : '3 3' });
      const tipEl = bldShapes[b.id]?.getTooltip()?.getElement();
      tipEl?.classList.toggle('closed', !open[b.id]);
    }
  }
  if (!origin || !dest) {
    $('routes').innerHTML = `<p class="note">${!origin && !dest ? 'Choose a start and a destination, or tap two buildings on the map.' : !dest ? 'Now choose a destination.' : 'Now choose a starting point.'}</p>`;
    $('steps').innerHTML = ''; $('warn').innerHTML = ''; navSteps = []; renderNav();
    setTrip(!origin && !dest ? 'Choose a start and a destination' : !dest ? 'Now choose a destination' : 'Now choose a starting point');
    syncMini();
    routeLayer.clearLayers();
    return;
  }
  const src = routeNode(origin), dst = routeNode(dest);
  if (origin.kind === 'building') open[origin.id] = true;
  if (dest.kind === 'building') open[dest.id] = true;
  const ctx = buildContext(model, {
    sunFrac, sun, tempC: fToC(tempF), wind: cond.wind, cloudPct: cond.cloud, precipMm: cond.precipMm, w: 0,
    open, stepFree: ($('stepfree') as HTMLInputElement).checked, noJaywalk: ($('nojaywalk') as HTMLInputElement).checked, mins,
    noCutThrough: !($('crossbld') as HTMLInputElement).checked,
    // you can always walk out of where you start and into where you are going
    throughOk: [origin, dest].filter((p) => p?.kind === 'building').map((p) => (p as { id: string }).id),
  });
  // Any change of conditions resets the highlighted route to the comfortable one.
  selected = 'comfort';
  lastRoutes = {
    fast: dijkstra(model, src, dst, ctx),
    comfy: dijkstra(model, src, dst, { ...ctx, w }),
    ctx: { ...ctx, w }, src,
  };
  renderRoutes();
  // a new pair is a new walk: nothing is behind you yet
  const pair = src + '>' + dst;
  if (pair !== lastPair) {
    doneAlong = 0; offFixes = 0; following = false;
    lastPair = pair;
    fitRoute();
    // on phones, drop the sheet to a peek and shrink the search card so the route is visible
    if (isMobile()) { setSheet('peek'); syncMini(); syncTop(); }
  }
  writeHash();
}
function fitRoute() {
  const r = lastRoutes && (lastRoutes.comfy || lastRoutes.fast);
  if (!r || !model) return;
  const pts: [number, number][] = [];
  for (const e of r) { pts.push(ll(model.nodes[e.a]), ll(model.nodes[e.b])); }
  const mobile = isMobile();
  map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: mobile ? [20, topEl.offsetHeight + 24] : [440, 40],
    paddingBottomRight: mobile ? [20, 130] : [40, 40], // sheet peeks after a new route
    maxZoom: 18,
  });
}
/** Draws the alternative faintly and the shown route from where you are on. */
function paintRoute(ctx: RouteContext, alt: Edge[] | null) {
  if (!model) return;
  routeLayer.clearLayers();
  if (alt)
    for (const e of alt) {
      const A = ll(model.nodes[e.a]), B = ll(model.nodes[e.b]);
      L.polyline([A, B], { pane: 'routes', color: '#555960', weight: 2, opacity: 0.35, dashArray: '2 6' }).addTo(routeLayer);
    }
  for (const run of remainingRuns(shownLegs, doneAlong)) {
    const A = ll(run.a), B = ll(run.b);
    const shelter = run.e.kind === 'link' && (run.e.linkKind === 'subwalk' || run.e.linkKind === 'skywalk');
    const color = run.e.kind === 'outdoor' ? sunColor(ctx.sunFrac[run.e.id]) : shelter ? '#6F5A2E' : '#8E6F3E';
    L.polyline([A, B], { pane: 'routes', color: '#FCFBF7', weight: 9, opacity: 0.9 }).addTo(routeLayer);
    L.polyline([A, B], {
      pane: 'routes', color, weight: 5, opacity: 1, lineCap: 'round',
      dashArray: run.e.kind === 'outdoor' ? undefined : shelter ? '2 7' : '1 8',
    }).addTo(routeLayer);
    // A dashed line alone does not say "you go underground here", so the
    // maneuver's own icon rides the segment it belongs to.
    if (shelter) {
      const under = run.e.linkKind === 'subwalk';
      const mid: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const label = `${under ? 'Tunnel' : 'Skywalk'}${run.e.bldA && run.e.bldB ? `: ${model.byId[run.e.bldA].abbr} – ${model.byId[run.e.bldB].abbr}` : ''}`;
      L.marker(mid, {
        pane: 'routes', interactive: true, keyboard: false,
        icon: L.divIcon({
          className: '',
          html: `<div class="tbadge">${icon(under ? 'tunnel' : 'bridge', 16)}</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        }),
      }).addTo(routeLayer).bindTooltip(label, { direction: 'top', offset: [0, -12], className: 'st' });
    }
  }
}

function renderRoutes() {
  if (!lastRoutes || !model || !origin || !dest) return;
  const { fast, comfy, ctx, src } = lastRoutes;
  const box = $('routes'), warn = $('warn');
  box.innerHTML = ''; warn.innerHTML = ''; routeLayer.clearLayers();
  if (src === routeNode(dest)) { box.innerHTML = '<p class="note">Start and destination are the same place.</p>'; $('steps').innerHTML = ''; navSteps = []; renderNav(); setTrip('Start and destination are the same place'); return; }
  if (!fast) {
    box.innerHTML = `<p class="note">No route found. ${esc(diagnose(model, origin, dest, ctx))}</p>`;
    $('steps').innerHTML = ''; navSteps = []; renderNav();
    setTrip('No route found — pull up for details');
    return;
  }
  for (const [pl, role] of [[dest, 'destination'], [origin, 'start']] as [Place, string][])
    if (pl.kind === 'building') {
      const b = model.byId[pl.id];
      const h = ctx.mins / 60;
      if (!(h >= b.hours[0] && h < b.hours[1]))
        warn.innerHTML += `<div class="warn">${b.abbr} may be closed at ${fmtClock(ctx.mins)} (${b.hoursTagged ? 'OSM hours' : 'assumed hours'} ${fmtHours(b.hours)}). The ${role} is still routed to its door.</div>`;
    }
  const same = !!comfy && fast.map((e) => e.id).join() === comfy.map((e) => e.id).join();
  const shown = same ? 'fast' : selected;
  const fs = summarize(fast, ctx);
  const items = [
    { key: 'fast' as const, label: 'Fastest', path: fast },
    { key: 'comfort' as const, label: 'More comfortable', path: same ? null : comfy },
  ];
  for (const it of items) {
    if (!it.path) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = 'The fastest route is already the most comfortable for these conditions.';
      box.appendChild(p);
      continue;
    }
    const s = summarize(it.path, ctx);
    const pct = (v: number) => ((100 * v) / s.len).toFixed(1) + '%';
    const via = s.via
      .filter((id) => !(origin!.kind === 'building' && id === origin!.id) && !(dest!.kind === 'building' && id === dest!.id))
      .map((id) => model!.byId[id]?.abbr).filter(Boolean);
    const extra = it.key === 'comfort' ? Math.round((s.time - fs.time) / 60) : 0;
    const arrive = fmtClock((ctx.mins + Math.round(s.time / 60)) % 1440);
    const btn = document.createElement('button');
    btn.className = 'route';
    btn.setAttribute('aria-pressed', String(shown === it.key));
    btn.innerHTML = `<span class="name">${it.label}<small style="display:block;font-weight:500;color:var(--muted);font-size:12px">arrive ${arrive}${s.crossings ? `, ${s.crossings} crossing${s.crossings > 1 ? 's' : ''}` : ''}${s.jaywalks ? `, ${s.jaywalks} unmarked` : ''}</small></span><span class="time">${fmtMin(s.time)}${extra > 0 ? `<small>+${extra} min</small>` : ''}</span>
      <span class="strip"><i class="in" style="width:${pct(s.indoorLen)}"></i><i class="sh" style="width:${pct(s.shadeLen)}"></i><i class="su" style="width:${pct(s.sunLen)}"></i></span>
      <span class="sub"><span>${dist(s.len)}, ${dist(s.sunLen)} in sun${s.worst !== null ? `, ${ctx.hot ? 'hottest' : 'coldest'} stretch feels ${Math.round(cToF(s.worst))} °F` : ''}</span><span>${via.length ? 'through ' + via.join(', ') : 'outdoors the whole way'}</span></span>`;
    btn.onclick = () => { selected = it.key; renderRoutes(); };
    box.appendChild(btn);
    if (shown === it.key) {
      if (s.unverified) warn.innerHTML += '<div class="warn">This route uses an indoor link that has not been verified on foot.</div>';
      if (s.assumedDoors) warn.innerHTML += `<div class="warn">${s.assumedDoors} door${s.assumedDoors > 1 ? 's' : ''} on this route ${s.assumedDoors > 1 ? 'are' : 'is'} not mapped in OSM and ${s.assumedDoors > 1 ? 'were' : 'was'} assumed from where the sidewalk meets the wall. If one is wrong, add the real entrance to OpenStreetMap and reload.</div>`;
      if (s.jaywalks) warn.innerHTML += '<div class="warn">This route crosses a street where OSM has no crossing mapped. Tick "Only cross at crossings" to avoid it.</div>';
      if (s.unlitLen > 60) warn.innerHTML += `<div class="warn">${dist(s.unlitLen)} of this route has no street lighting mapped in OSM. Routing already prefers lit paths after dark.</div>`;
      if (s.majorCrossings) warn.innerHTML += `<div class="warn">Crosses ${s.majorCrossings} main road${s.majorCrossings > 1 ? 's' : ''}. Use the signals and watch for turning traffic.</div>`;
    }
  }
  const shownPath = (shown === 'fast' ? fast : comfy)!;
  shownLegs = orderedLegs(model, shownPath, src);
  // the route may have just been rebuilt under us (a slider move, or switching to
  // the other option), so re-measure progress against the new line rather than
  // carrying a distance that belonged to the old one
  if (lastFix) {
    const pr = progressOn(shownLegs, proj.xy(lastFix.lat, lastFix.lon));
    doneAlong = pr && pr.off <= FOLLOW_M ? pr.along : 0;
  }
  paintRoute(ctx, !same && comfy ? (shown === 'fast' ? comfy : fast) : null);
  const steps = directions(model, shownPath, src, ctx);
  stepAlong = stepDistances(shownLegs, steps.map((st) => st.at));
  const ss = summarize(shownPath, ctx);
  setTrip(`<b>${fmtMin(ss.time)}</b> · arrive ${fmtClock((ctx.mins + Math.round(ss.time / 60)) % 1440)} · ${shown === 'fast' ? 'fastest' : 'comfortable'} route`);
  $('steps').innerHTML = steps.map((s, i) => `<li data-i="${i}"${s.warn ? ' style="background:#FFF4E5"' : ''}><span class="mic ${s.icon}">${maneuverSvg(s.maneuver)}</span><span>${esc(s.text)}${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span><span class="m">${dist(s.m)}</span></li>`).join('');
  $('steps').querySelectorAll('li').forEach((li) => (li.onclick = () => goStep(+li.dataset.i!)));
  const sameRoute = navSteps.length === steps.length && navSteps.every((s, i) => s.text === steps[i].text);
  navSteps = steps;
  if (!sameRoute) navI = 0;
  renderNav();
}

/* ================= boot ================= */
function start(osm: OsmData, sourceNote?: string) {
  rawOsm = osm;
  model = buildModel(osm, proj, { weekday: new Date().getDay(), overrides, heights });
  basemap = extractBasemap(osm, proj);
  const named = model.buildings.filter((b) => b.named && b.campus);
  if (named.length < 2) { showError(new Error('fewer than two named campus buildings in this block')); return; }
  // a new model invalidates everything keyed to the old one
  shadeCache = null; shadowKey = ''; openKey = '';
  applyBasemap(); drawModel(); routeLayer.clearLayers();
  const links = model.edges.filter((e) => e.kind === 'link').length;
  const lidarN = heights ? model.buildings.filter((b) => b.heightSource === 'lidar').length : 0;
  const src = sourceNote ?? (osm._source ? `from ${osm._source} in ${osm._seconds} s` : 'from the bundled extract');
  let age = '';
  if (osm._fetched) {
    const days = Math.floor((Date.now() - new Date(osm._fetched).getTime()) / 86400000);
    age = days > STALE_DAYS
      ? ` <b>The data is ${days} days old</b> — refresh it with <code>npm run update-data</code> or "Save data for next time".`
      : ` Data is ${days} day${days === 1 ? '' : 's'} old.`;
  }
  // model stats and data buttons live in the data section, not above the route cards
  $('loadbox').innerHTML = '';
  $('datastats').innerHTML = `<p class="status"><b>${model.buildings.filter((b) => b.campus).length}</b> campus buildings (${named.length} named, ${model.buildings.length - model.buildings.filter((b) => b.campus).length} off-campus drawn for shade), <b>${model.edges.filter((e) => e.kind === 'outdoor' && !e.connector).length}</b> path segments, <b>${model.trees.length}</b> ${heights?.canopy?.length ? 'canopy patches (lidar)' : 'trees'}${lidarN ? `, <b>${lidarN}</b> lidar heights` : ''}${links ? `, <b>${links}</b> indoor link segments` : ''}, ${model.crossings} mapped crossings, ${model.gapsClosed} sidewalk gaps closed${model.jaywalks ? `, ${model.jaywalks} footways cross a street with no crossing` : ''}, ${src}.${age}</p>
  <div class="btnrow" style="margin:0 0 4px"><button class="btn quiet" id="saveosm">Save data for next time</button><label class="btn quiet" style="display:inline-block">Load saved data<input type="file" id="jsonfile2" accept="application/json,.json" style="display:none"></label></div>`;
  $('saveosm').onclick = saveOsm;
  loadFile($<HTMLInputElement>('jsonfile2'));
  ($('planner') as HTMLElement).hidden = false;
  const now = new Date();
  const dateInp = $('date') as HTMLInputElement;
  if (!dateInp.value) {
    dateInp.value = todayISO();
    ($('time') as HTMLInputElement).value = String((Math.round((now.getHours() * 60 + now.getMinutes()) / 15) * 15) % 1440);
  }
  // only now that the clock is set, since a layer switch can redraw
  applyLayers();
  readHash();
  update();
}

async function boot(forceOverpass = false) {
  void loadWeather(CAMPUS.lat, CAMPUS.lon).then((state) => { wx = state; if (model) update(); });
  let osmData: OsmData | null = null;
  try {
    if (!heights)
      heights = await fetch('./campus-heights.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let data: OsmData | null = forceOverpass ? null : await loadBundledData(DATA_URL);
    if (!data)
      data = await loadOverpass(BBOX, (msg) => setStatus(esc(msg).replace(/\n/g, '<br><small>') + (msg.includes('\n') ? '</small>' : '')));
    osmData = data;
  } catch (e) { showError(e); return; }
  // drawing failures are a separate problem from fetching failures
  try { start(osmData!); } catch (e) { showFatal(e); }
}
void boot();

// Offline support once the app has been visited (PWA).
if ('serviceWorker' in navigator && !import.meta.env.DEV)
  navigator.serviceWorker.register('./sw.js').catch(() => {});
