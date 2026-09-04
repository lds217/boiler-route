import { FETCH_TIMEOUT, OVERPASS_ENDPOINTS, overpassQuery } from './constants';
import type { LatLonBBox, OsmData } from './types';
import { fetchWithTimeout } from './weather';

/**
 * Load the study area, preferring the bundled extract (updated weekly by CI) so
 * end users never hit Overpass. Overpass is the fallback for development.
 */
export async function loadBundledData(url = './boiler-route-data.json'): Promise<OsmData | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = (await r.json()) as OsmData;
    if (!j.elements || !j.elements.length) return null;
    return j;
  } catch {
    return null; // fails on file:// or when the bundle is absent
  }
}

export async function loadOverpass(
  bbox: LatLonBBox,
  onStatus?: (msg: string) => void,
): Promise<OsmData> {
  const log: string[] = [];
  const query = overpassQuery(bbox);
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = OVERPASS_ENDPOINTS[i], host = new URL(url).host, t0 = Date.now();
    onStatus?.(`Asking ${host} for the study area (${i + 1} of ${OVERPASS_ENDPOINTS.length}), up to ${FETCH_TIMEOUT / 1000} s…` +
      (log.length ? '\n' + log.join('\n') : ''));
    try {
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, FETCH_TIMEOUT);
      if (r.status === 429) throw new Error('rate limited (429). Wait a minute, or load a saved file.');
      if (r.status === 504) throw new Error('server too busy (504)');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as OsmData;
      if (!j.elements || !j.elements.length) throw new Error('empty response');
      j._source = host;
      j._seconds = ((Date.now() - t0) / 1000).toFixed(1);
      return j;
    } catch (e) {
      const err = e as Error;
      log.push(`${host}: ${err.name === 'AbortError' ? `no answer in ${FETCH_TIMEOUT / 1000} s` : err.message}`);
    }
  }
  throw new Error(log.join(' / '));
}
