import '@fontsource-variable/inter';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
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
import { buildContext, dijkstra, summarize } from '../routing';
import { computeShade } from '../shade';
import { sunPosition } from '../sun';
import type { CampusOverrides, Edge, HeightsData, Model, OsmData, Place, RouteContext, Wind } from '../types';
import { loadWeather, weatherAt, type WeatherState } from '../weather';

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

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtMin = (s: number): string => { const m = Math.round(s / 60); return m < 1 ? '<1 min' : `${m} min`; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sunColor = (f: number) => {
  const c1 = [79, 113, 134], c2 = [226, 87, 43];
  return `rgb(${c1.map((v, i) => Math.round(lerp(v, c2[i], f))).join(',')})`;
};
const ll = (p: { x: number; y: number }): [number, number] => proj.ll(p);

/* ================= map ================= */
// Extra canvas padding renders past the viewport so panning doesn't redraw every frame.
const map = L.map('map', { zoomControl: false, preferCanvas: true, renderer: L.canvas({ padding: 0.5 }) }).setView([CAMPUS.lat, CAMPUS.lon], 17);
L.control.zoom({ position: 'topright' }).addTo(map);
const syncLabels = () => document.body.classList.toggle('lowzoom', map.getZoom() < 16);
map.on('zoomend', syncLabels); syncLabels();
map.createPane('ground').style.zIndex = '330';
map.createPane('base').style.zIndex = '340';
map.createPane('shadow').style.zIndex = '350';
map.createPane('net').style.zIndex = '360';
map.createPane('routes').style.zIndex = '450';
// The vectors are OSM data, so attribution stays visible whatever the basemap.
map.attributionControl.addAttribution(
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '· <a href="https://github.com/purdue-boiler-route/boiler-route/issues">Report a map issue</a>');
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 });
const groundLayer = L.layerGroup().addTo(map);
const shadowLayer = L.layerGroup().addTo(map);
const netLayer = L.layerGroup();
const routeLayer = L.layerGroup().addTo(map);
const bldLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
L.rectangle([[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]], { color: '#221E19', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);
const bldShapes: Record<string, L.Polygon> = {};

const GROUND_FILL: Record<string, string> = {
  green: '#D3DABF', wood: '#BFCBA8', water: '#B7CBD9', parking: '#DCD8CE', pitch: '#CBD8C2', sand: '#E7DFC8', dirt: '#DDD5C5',
};
function drawBasemap() {
  groundLayer.clearLayers();
  if (!basemap || $('basemap') && ($('basemap') as HTMLSelectElement).value !== 'builtin') return;
  for (const g of basemap.ground)
    L.polygon(g.ring.map(ll), { pane: 'ground', stroke: false, fillColor: GROUND_FILL[g.kind], fillOpacity: 0.8, interactive: false }).addTo(groundLayer);
  for (const s of basemap.lines) {
    const style = s.klass === 'major' ? { color: '#FFFFFF', weight: 9, opacity: 0.95 }
      : s.klass === 'minor' ? { color: '#FFFFFF', weight: 7, opacity: 0.9 }
      : s.klass === 'service' ? { color: '#F2EFE7', weight: 4, opacity: 0.9 }
      : { color: '#DAD4C6', weight: 2, opacity: 0.9, dashArray: undefined };
    const line = L.polyline(s.pts.map(ll), { pane: 'base', interactive: false, ...style }).addTo(groundLayer);
    if (s.name && s.klass !== 'walk')
      line.bindTooltip(s.name, { permanent: false, direction: 'center', className: 'st' });
  }
}

// The walkable-network overlay is thousands of polylines; build it only when first shown.
let netBuilt = false;
function buildNet() {
  if (netBuilt || !model) return;
  netBuilt = true;
  for (const e of model.edges) {
    const A = ll(model.nodes[e.a]), B = ll(model.nodes[e.b]);
    const st = e.kind === 'outdoor'
      ? { color: e.connector ? '#C9B98A' : '#8E877A', weight: 1.2, opacity: 0.7 }
      : { color: '#A67C12', weight: 2, dashArray: '4 4', opacity: 0.9 };
    L.polyline([A, B], { pane: 'net', ...st }).addTo(netLayer);
  }
}
function drawModel() {
  if (!model) return;
  bldLayer.clearLayers(); netLayer.clearLayers(); netBuilt = false;
  for (const b of model.buildings) {
    // Off-campus buildings are scenery: muted, unlabeled, clicks fall through to the map.
    const poly = L.polygon(b.ring.map(ll), b.campus
      ? { color: '#8F8779', weight: 1, fillColor: '#CBC5B7', fillOpacity: 0.85, bubblingMouseEvents: false }
      : { color: '#A9A396', weight: 0.8, fillColor: '#DDD9CF', fillOpacity: 0.6, interactive: false }).addTo(bldLayer);
    if (b.campus && b.named) poly.bindTooltip(b.abbr, { permanent: true, direction: 'center', className: 'bl' });
    if (b.campus) poly.on('click', () => { if (b.named) setPlace({ kind: 'building', id: b.id, label: `${b.abbr}  ${b.name}` }); });
    bldShapes[b.id] = poly;
  }
  for (const t of model.trees)
    L.circle(ll(t.c), { radius: t.r, color: '#7F9569', weight: 1, fillColor: '#A9B992', fillOpacity: 0.7, interactive: false }).addTo(bldLayer);
}

map.on('click', (e) => { const p = pointAt(e.latlng); if (p) setPlace(p); });
function pointAt(latlng: { lat: number; lng: number }): Place | null {
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
    else if (act === 'map') { pendingField = field; ($(field) as HTMLInputElement).value = ''; ($(field) as HTMLInputElement).placeholder = 'Now tap the map'; closeSugg(); }
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
    setStatus(`<b>${esc(b.name)}</b>: ${b.doorsTagged} tagged entrance${b.doorsTagged === 1 ? '' : 's'}${b.doorsAssumed ? `, ${b.doorsAssumed} assumed` : ''}${b.doorsSkipped.length ? `, ${b.doorsSkipped.length} unusable (${[...new Set(b.doorsSkipped)].join(', ')})` : ''}; height ${Math.round(b.height)} m (${b.heightSource === 'lidar' ? 'lidar' : b.heightSource === 'osm' ? 'OSM' : 'assumed'}); hours ${fmtHours(b.hours)} ${b.hoursTagged ? '(OSM)' : '(assumed)'}.`);
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
function showFix(lat: number, lon: number, acc: number) {
  lastFix = { lat, lon };
  try { localStorage.setItem('geoOk', '1'); } catch { /* private mode */ }
  if (!locDot) {
    locRing = L.circle([lat, lon], { radius: acc, color: '#1F5FBF', weight: 1, opacity: 0.4, fillColor: '#1F5FBF', fillOpacity: 0.08, interactive: false }).addTo(map);
    locDot = L.circleMarker([lat, lon], { pane: 'routes', radius: 7, color: '#fff', weight: 2.5, fillColor: '#1F5FBF', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    locDot.setLatLng([lat, lon]);
    locRing!.setLatLng([lat, lon]).setRadius(acc);
  }
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
locBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3.5M12 19v3.5M1.5 12H5M19 12h3.5"/></svg>';
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
  return 21 + $('tripbar').offsetHeight + safeProbe.offsetHeight; // handle + trip bar
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
/** Google-Maps-style maneuver glyphs, drawn on a 24×24 grid. */
const MANEUVER: Record<string, string> = {
  start: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8.5"/>',
  straight: '<path d="M12 21V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/>',
  left: '<path d="M18 21v-8a4 4 0 0 0-4-4H6"/><path d="m10.5 4.5-5.5 4.5 5.5 4.5"/>',
  right: '<path d="M6 21v-8a4 4 0 0 1 4-4h8"/><path d="m13.5 4.5 5.5 4.5-5.5 4.5"/>',
  uturn: '<path d="M8 21V10a4.5 4.5 0 0 1 9 0v3"/><path d="m12.5 17 4.5 4.5 4.5-4.5"/>',
  cross: '<path d="M5 20 9 4M11 20l4-16M17 20l4-16" stroke-dasharray="3 3"/>',
  exit: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8"/><path d="M11 12h10"/><path d="m17.5 7.5 4.5 4.5-4.5 4.5"/>',
  arrive: '<path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  through: '<path d="M4 20V8l7-4 7 4v12"/><path d="M4 20h16"/><path d="M8 20v-6h6v6"/>',
  link: '<path d="M3 16h18"/><path d="M6 16V9M18 16V9"/><path d="M3 9c4-3 14-3 18 0"/>',
};
const maneuverSvg = (m: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MANEUVER[m] ?? MANEUVER.straight}</svg>`;
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
  $('navm').textContent = `${s.m} m`;
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
  if (!turnDot) turnDot = L.circleMarker(c, { pane: 'routes', radius: 9, color: '#221E19', weight: 3, fillColor: '#FBFAF6', fillOpacity: 1, interactive: false }).addTo(map);
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
  for (const t of ['route', 'cond', 'data']) ($('tab-' + t) as HTMLElement).hidden = t !== b.dataset.tab;
  if (isMobile() && sheetPos === 'peek') setSheet('half');
}));

/* ================= conditions ================= */
for (const id of ['date', 'tempn', 'wind', 'cloud', 'time', 'comfort', 'manual', 'stepfree', 'nojaywalk'])
  $(id).addEventListener('input', () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(update); });
$('basemap').addEventListener('change', () => {
  const v = ($('basemap') as HTMLSelectElement).value;
  if (v === 'tiles') { tiles.addTo(map); } else { map.removeLayer(tiles); }
  drawBasemap();
});
$('shownet').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) { buildNet(); netLayer.addTo(map); } else map.removeLayer(netLayer);
});
function nearestOption(sel: HTMLSelectElement, v: number) {
  let best: string | null = null, bd = 1e9;
  for (const o of sel.options) { const d = Math.abs(+o.value - v); if (d < bd) { bd = d; best = o.value; } }
  if (best !== null) sel.value = best;
}
function conditions(): { tempF: number; wind: Wind; cloud: number } {
  const manual = ($('manual') as HTMLInputElement).checked;
  const mins = +($('time') as HTMLInputElement).value;
  const dateStr = ($('date') as HTMLInputElement).value;
  for (const id of ['tempn', 'wind', 'cloud']) ($(id) as HTMLSelectElement).disabled = !manual;
  const w = weatherAt(wx, dateStr, mins);
  if (!manual && w) {
    nearestOption($('tempn') as HTMLSelectElement, w.tempF);
    ($('wind') as HTMLSelectElement).value = windClass(w.mph);
    nearestOption($('cloud') as HTMLSelectElement, w.cloud);
    $('wx').innerHTML = `Live for ${fmtClock(mins)}: <b>${Math.round(w.tempF)} °F</b>, wind ${Math.round(w.mph)} mph, ${Math.round(w.cloud)}% cloud <small>(Open-Meteo, fetched ${wx.fetchedAt!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})</small>`;
    return { tempF: w.tempF, wind: windClass(w.mph), cloud: w.cloud };
  }
  if (!manual) $('wx').innerHTML = wx.ok
    ? 'No forecast for that date and time (Open-Meteo covers about 3 days). Using the manual values below.'
    : wx.err ? `Live weather unavailable (${esc(wx.err)}). Using the manual values below.` : 'Fetching live weather…';
  else $('wx').innerHTML = 'Manual conditions.';
  return { tempF: +($('tempn') as HTMLSelectElement).value, wind: ($('wind') as HTMLSelectElement).value as Wind, cloud: +($('cloud') as HTMLSelectElement).value };
}

/* ================= update + render ================= */
function update() {
  raf = null;
  if (!model) return;
  const mins = +($('time') as HTMLInputElement).value;
  const w = +($('comfort') as HTMLInputElement).value / 100;
  const cond = conditions();
  const tempF = cond.tempF;
  ($('timeout') as HTMLOutputElement).value = fmtClock(mins);
  ($('comfortout') as HTMLOutputElement).value = w === 0 ? 'Fastest' : `${Math.round(w * 100)}%`;
  ($('comfort') as HTMLInputElement).style.setProperty('--fill', `${w * 100}%`);
  ($('time') as HTMLInputElement).style.setProperty('--fill', `${(mins / 1425) * 100}%`);
  const date = new Date(($('date') as HTMLInputElement).value + 'T00:00:00');
  date.setMinutes(mins);
  const sun = sunPosition(date, CAMPUS.lat, CAMPUS.lon);
  const { sunFrac, shadows } = computeShade(model, sun);
  const sunAddF = Math.round(SUN_MAX_C * Math.max(0, Math.sin(sun.alt)) * (1 - (CLOUD_CUT * cond.cloud) / 100) * 9 / 5);
  $('condcur').textContent = `${fmtClock(mins)}, ${Math.round(tempF)} °F${sunAddF ? `, sun +${sunAddF} °F` : ''}`;
  $('suntext').lastElementChild!.textContent = sun.alt <= 0 ? 'Night' : `Sun ${Math.round((sun.alt * 180) / Math.PI)}° ${compassShort(sun.bearing)}, +${sunAddF} °F`;
  shadowLayer.clearLayers();
  // One multipolygon = one canvas path: much cheaper than hundreds of layers, and
  // overlapping shadows no longer double-darken.
  if (shadows.length)
    L.polygon(shadows.map((h) => [h.map(ll)]), { pane: 'shadow', stroke: false, fillColor: '#221E19', fillOpacity: 0.16, interactive: false }).addTo(shadowLayer);

  const open = computeOpen(model.buildings, date.getDay(), mins / 60);
  for (const b of model.buildings) {
    if (!b.campus) continue; // scenery keeps its muted style
    bldShapes[b.id]?.setStyle({ fillColor: open[b.id] ? '#CBC5B7' : '#DDD8CD', dashArray: open[b.id] ? undefined : '3 3' });
    const tipEl = bldShapes[b.id]?.getTooltip()?.getElement();
    tipEl?.classList.toggle('closed', !open[b.id]);
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
    sunFrac, sun, tempC: fToC(tempF), wind: cond.wind, cloudPct: cond.cloud, w: 0,
    open, stepFree: ($('stepfree') as HTMLInputElement).checked, noJaywalk: ($('nojaywalk') as HTMLInputElement).checked, mins,
  });
  // Any change of conditions resets the highlighted route to the comfortable one.
  selected = 'comfort';
  lastRoutes = {
    fast: dijkstra(model, src, dst, ctx),
    comfy: dijkstra(model, src, dst, { ...ctx, w }),
    ctx: { ...ctx, w }, src,
  };
  renderRoutes();
  const pair = src + '>' + dst;
  if (pair !== lastPair) {
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
      <span class="sub"><span>${Math.round(s.len)} m, ${Math.round(s.sunLen)} m in sun${s.worst !== null ? `, ${ctx.hot ? 'hottest' : 'coldest'} stretch feels ${Math.round(cToF(s.worst))} °F` : ''}</span><span>${via.length ? 'through ' + via.join(', ') : 'outdoors the whole way'}</span></span>`;
    btn.onclick = () => { selected = it.key; renderRoutes(); };
    box.appendChild(btn);
    if (shown === it.key) {
      if (s.unverified) warn.innerHTML += '<div class="warn">This route uses an indoor link that has not been verified on foot.</div>';
      if (s.assumedDoors) warn.innerHTML += `<div class="warn">${s.assumedDoors} door${s.assumedDoors > 1 ? 's' : ''} on this route ${s.assumedDoors > 1 ? 'are' : 'is'} not mapped in OSM and ${s.assumedDoors > 1 ? 'were' : 'was'} assumed from where the sidewalk meets the wall. If one is wrong, add the real entrance to OpenStreetMap and reload.</div>`;
      if (s.jaywalks) warn.innerHTML += '<div class="warn">This route crosses a street where OSM has no crossing mapped. Tick "Only cross at crossings" to avoid it.</div>';
    }
  }
  const draw = (path: Edge[], hi: boolean) => {
    for (const e of path) {
      const A = ll(model!.nodes[e.a]), B = ll(model!.nodes[e.b]);
      if (!hi) { L.polyline([A, B], { pane: 'routes', color: '#221E19', weight: 2, opacity: 0.35, dashArray: '2 6' }).addTo(routeLayer); continue; }
      const color = e.kind === 'outdoor' ? sunColor(ctx.sunFrac[e.id]) : '#A67C12';
      L.polyline([A, B], { pane: 'routes', color: '#FBFAF6', weight: 9, opacity: 0.9 }).addTo(routeLayer);
      L.polyline([A, B], { pane: 'routes', color, weight: 5, opacity: 1, dashArray: e.kind === 'outdoor' ? undefined : '1 8', lineCap: 'round' }).addTo(routeLayer);
    }
  };
  const shownPath = (shown === 'fast' ? fast : comfy)!;
  if (!same && comfy) draw(shown === 'fast' ? comfy : fast, false);
  draw(shownPath, true);
  const steps = directions(model, shownPath, src, ctx);
  const ss = summarize(shownPath, ctx);
  setTrip(`<b>${fmtMin(ss.time)}</b> · arrive ${fmtClock((ctx.mins + Math.round(ss.time / 60)) % 1440)} · ${shown === 'fast' ? 'fastest' : 'comfortable'} route`);
  $('steps').innerHTML = steps.map((s, i) => `<li data-i="${i}"${s.warn ? ' style="background:#FFF4E5"' : ''}><span class="mic ${s.icon}">${maneuverSvg(s.maneuver)}</span><span>${esc(s.text)}${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span><span class="m">${s.m} m</span></li>`).join('');
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
  drawBasemap(); drawModel(); routeLayer.clearLayers();
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
    dateInp.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    ($('time') as HTMLInputElement).value = String((Math.round((now.getHours() * 60 + now.getMinutes()) / 15) * 15) % 1440);
  }
  readHash();
  update();
}

async function boot(forceOverpass = false) {
  void loadWeather(CAMPUS.lat, CAMPUS.lon).then((state) => { wx = state; if (model) update(); });
  try {
    if (!heights)
      heights = await fetch('./campus-heights.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!forceOverpass) {
      const bundled = await loadBundledData(DATA_URL);
      if (bundled) { start(bundled); return; }
    }
    start(await loadOverpass(BBOX, (msg) => setStatus(esc(msg).replace(/\n/g, '<br><small>') + (msg.includes('\n') ? '</small>' : ''))));
  } catch (e) { showError(e); }
}
void boot();

// Offline support once the app has been visited (PWA).
if ('serviceWorker' in navigator && !import.meta.env.DEV)
  navigator.serviceWorker.register('./sw.js').catch(() => {});
