/**
 * One icon set for the whole app: 24×24 grid, 1.8 stroke, round caps and joins,
 * `currentColor` only. Markup lives here so an icon looks identical wherever it
 * is used — HTML writes `<span data-icon="swap">`, TypeScript calls `icon()`.
 */
const PATHS: Record<string, string> = {
  /* interface */
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5.2 5.2 7 7M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8"/>',
  swap: '<path d="M7 3.5v14M3.6 14.1 7 17.5l3.4-3.4M17 20.5v-14M13.6 9.9 17 6.5l3.4 3.4"/>',
  gps: '<path d="M20.5 3.5 3.5 10.2a.5.5 0 0 0 0 .93l7.05 2.32 2.32 7.05a.5.5 0 0 0 .93 0z"/>',
  crosshair: '<circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.4"/><path d="M12 1.9v2.7M12 19.4v2.7M1.9 12h2.7M19.4 12h2.7"/>',
  link: '<path d="M10 13.2a4.6 4.6 0 0 0 6.9.5l2.1-2.1a4.6 4.6 0 0 0-6.5-6.5l-1.2 1.2"/><path d="M14 10.8a4.6 4.6 0 0 0-6.9-.5L5 12.4a4.6 4.6 0 0 0 6.5 6.5l1.2-1.2"/>',
  route: '<circle cx="6" cy="18.5" r="2.4"/><circle cx="18" cy="5.5" r="2.4"/><path d="M8.4 18.5h5.1a3.6 3.6 0 0 0 0-7.2h-3a3.6 3.6 0 0 1 0-7.2h5.1"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chevronDown: '<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>',

  /* maneuvers */
  start: '<circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.8"/>',
  straight: '<path d="M12 20.5V5.2"/><path d="M6.9 10.3 12 5.2l5.1 5.1"/>',
  left: '<path d="M17.6 20.5v-7.4a3.6 3.6 0 0 0-3.6-3.6H6.9"/><path d="M11.4 5 6.4 9.5l5 4.5"/>',
  right: '<path d="M6.4 20.5v-7.4a3.6 3.6 0 0 1 3.6-3.6h7.1"/><path d="M12.6 5l5 4.5-5 4.5"/>',
  uturn: '<path d="M7.6 20.5v-9.9a4.4 4.4 0 0 1 8.8 0v3.6"/><path d="m12.4 15.6 4 4.4 4-4.4"/>',
  cross: '<path d="M4.8 20 8.4 4M10.6 20l3.6-16M16.4 20 20 4"/>',
  exit: '<path d="M13.6 3.5H6.2a.7.7 0 0 0-.7.7v15.6a.7.7 0 0 0 .7.7h7.4"/><path d="M11 12h9.5"/><path d="m16.8 7.8 4.2 4.2-4.2 4.2"/>',
  arrive: '<path d="M12 20.8c0 0 6.6-6.2 6.6-11a6.6 6.6 0 1 0-13.2 0c0 4.8 6.6 11 6.6 11z"/><circle cx="12" cy="9.6" r="2.4"/>',
  through: '<path d="M4.5 20V8.2L12 4l7.5 4.2V20"/><path d="M3.2 20h17.6"/><path d="M9 20v-5.4h6V20"/>',
  tunnel: '<path d="M2.6 20.4V12a9.4 9.4 0 0 1 18.8 0v8.4"/><path d="M8.2 20.4V12a3.8 3.8 0 0 1 7.6 0v8.4"/>',
  bridge: '<path d="M3 16.2h18"/><path d="M6.6 16.2V9.4M17.4 16.2V9.4"/><path d="M3 9.4c4.2-2.9 13.8-2.9 18 0"/>',
};

/** Aliases keep call sites reading like the thing they mean. */
const ALIAS: Record<string, string> = { link_: 'bridge', locate: 'gps' };

export function icon(name: string, size = 20): string {
  const d = PATHS[ALIAS[name] ?? name] ?? PATHS.straight;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/** Fills every `<span data-icon="name" [data-size="16"]>` under `root`. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]'))
    el.innerHTML = icon(el.dataset.icon!, +(el.dataset.size ?? 20));
}
