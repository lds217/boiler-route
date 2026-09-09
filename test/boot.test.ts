/**
 * @vitest-environment happy-dom
 *
 * The app crashing on load is the worst failure it can have, and nothing else
 * here exercises the startup path: this boots the real UI module against the
 * real bundled extract and fails if anything throws.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// a DOM environment resolves import.meta.url against the document, so read from
// the project root instead
const root = process.cwd();
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
// drop the module script tag: this test imports the module itself
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const osm = readFileSync(resolve(root, 'public/boiler-route-data.json'), 'utf8');
const heights = readFileSync(resolve(root, 'public/campus-heights.json'), 'utf8');

describe('the app boots', () => {
  const errors: unknown[] = [];

  beforeAll(async () => {
    document.body.innerHTML = body;
    // Leaflet's canvas renderer needs a 2D context; a DOM shim has none, and the
    // calls it makes are all draw commands whose return value is unused
    const ctx2d = new Proxy({}, {
      get: (_t, k) => (k === 'measureText' ? () => ({ width: 0 }) : k === 'canvas' ? document.createElement('canvas') : () => {}),
      set: () => true,
    });
    HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
    // a layer switch was saved on a previous visit: this is what broke startup,
    // because it redrew before the date field had been filled in
    localStorage.setItem('ly:lyHeights', '1');
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: true,
      json: async () => JSON.parse(String(url).includes('heights') ? heights : osm),
      text: async () => (String(url).includes('heights') ? heights : osm),
    }));
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    window.addEventListener('error', (e) => errors.push(e.error));
    await import('../src/ui/main');
    await new Promise((r) => setTimeout(r, 400)); // let boot() finish
  });

  it('draws the planner without throwing', () => {
    expect(errors, `startup threw: ${errors.map(String).join(' | ')}`).toHaveLength(0);
    expect(document.getElementById('planner')?.hasAttribute('hidden')).toBe(false);
  });

  it('fills the date and shows a real sun reading, not NaN', () => {
    const date = document.getElementById('date') as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sun = document.getElementById('suntext')!.textContent ?? '';
    expect(sun).not.toMatch(/NaN|undefined/);
  });

  it('does not show the data-load error box', () => {
    expect(document.getElementById('loadbox')!.innerHTML).not.toContain('Could not load');
    expect(document.getElementById('loadbox')!.innerHTML).not.toContain('drawing it failed');
  });
});
