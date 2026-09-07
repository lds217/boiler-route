/** Open-Meteo forecast (no key, CORS enabled): current + 3 days hourly. */
export interface WeatherHourly {
  time: string[];
  temperature_2m: number[];
  wind_speed_10m: number[];
  cloud_cover: number[];
  precipitation: number[];
}
export interface WeatherState {
  ok: boolean;
  current: { temperature_2m: number; wind_speed_10m: number; cloud_cover: number; precipitation: number } | null;
  hourly: WeatherHourly | null;
  fetchedAt: Date | null;
  err: string | null;
}
export interface WeatherSample { tempF: number; mph: number; cloud: number; precipMm: number; kind: 'forecast' }

export async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function loadWeather(lat: number, lon: number): Promise<WeatherState> {
  const wx: WeatherState = { ok: false, current: null, hourly: null, fetchedAt: null, err: null };
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&current=temperature_2m,wind_speed_10m,cloud_cover,precipitation` +
      `&hourly=temperature_2m,wind_speed_10m,cloud_cover,precipitation` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=mm&timezone=auto&forecast_days=3`;
    const r = await fetchWithTimeout(u, {}, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    wx.current = j.current;
    wx.hourly = j.hourly;
    wx.ok = true;
    wx.fetchedAt = new Date();
  } catch (e) {
    wx.ok = false;
    wx.err = e instanceof Error ? e.message : String(e);
  }
  return wx;
}

export function weatherAt(wx: WeatherState, dateStr: string, mins: number): WeatherSample | null {
  if (!wx.ok || !wx.hourly) return null;
  const h = Math.floor(mins / 60);
  const key = `${dateStr}T${String(h).padStart(2, '0')}:00`;
  const i = wx.hourly.time.indexOf(key);
  if (i >= 0) return {
    tempF: wx.hourly.temperature_2m[i], mph: wx.hourly.wind_speed_10m[i], cloud: wx.hourly.cloud_cover[i],
    precipMm: wx.hourly.precipitation?.[i] ?? 0, kind: 'forecast',
  };
  return null;
}
