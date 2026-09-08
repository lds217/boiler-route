# /// script
# requires-python = ">=3.10"
# dependencies = ["rasterio", "numpy", "pyproj", "shapely"]
# ///
"""
Building heights and tree canopy from the Purdue 2018 NDHM lidar tiles
(5 ft raster, NAD83(HARN) Indiana West ftUS, heights in US feet).

  uv run scripts/heights.py [tile.tif ...]

Reads building footprints from public/boiler-route-data.json, computes the
90th-percentile NDHM height per footprint (§2 of the handoff brief), and
extracts canopy (cells >= 4 m outside footprints, aggregated into circles)
within the study area plus a shadow margin. Writes public/campus-heights.json,
which the app merges at model-build time.
"""
import glob
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.merge import merge
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parent.parent
FT = 0.3048006096
MIN_BUILDING_FT = 6.6        # ignore cars/clutter when sampling a footprint
CANOPY_MIN_M = 4.0           # §2: threshold outside footprints
CANOPY_BLOCK_CELLS = 12      # 12 x 5 ft = 60 ft ≈ 18 m aggregation blocks
CANOPY_MIN_FRACTION = 0.15   # block must be at least this canopied
CANOPY_MAX_M = 35.0          # taller than any tree here: NDHM noise (birds, masts, aircraft)
MARGIN_FT = 300              # ~90 m: max realistic tree-shadow reach into the bbox

tiles = sys.argv[1:] or sorted(glob.glob(str(ROOT / "*_ndhm.tif")))
if not tiles:
    sys.exit("no NDHM tiles found (pass paths or drop *_ndhm.tif in the repo root)")

constants = (ROOT / "src/constants.ts").read_text()
bbox = [float(v) for v in re.search(r"BBOX[^=]*=\s*\[([^\]]+)\]", constants).group(1).split(",")]
south, west, north, east = bbox

osm = json.loads((ROOT / "public/boiler-route-data.json").read_text())
nodes = {e["id"]: (e["lon"], e["lat"]) for e in osm["elements"] if e["type"] == "node"}
ways = {e["id"]: e for e in osm["elements"] if e["type"] == "way"}

def ring_of(way):
    pts = [nodes[i] for i in way["nodes"] if i in nodes]
    return pts if len(pts) >= 4 else None

buildings = {}  # osmId -> lon/lat ring
for wid, w in ways.items():
    t = w.get("tags", {})
    if t.get("building") and t["building"] != "no":
        r = ring_of(w)
        if r:
            buildings[wid] = r
for e in osm["elements"]:
    if e["type"] == "relation" and e.get("tags", {}).get("building"):
        outers = [ways[m["ref"]] for m in e.get("members", [])
                  if m["type"] == "way" and m["role"] != "inner" and m["ref"] in ways]
        closed = next((w for w in outers if w["nodes"][0] == w["nodes"][-1]), None)
        if closed and (r := ring_of(closed)):
            buildings[e["id"]] = r

srcs = [rasterio.open(t) for t in tiles]
mosaic, transform = merge(srcs)
band = mosaic[0]
crs = srcs[0].crs
tile_bounds = [s.bounds for s in srcs]   # per tile, not the mosaic: corners may be missing
for s in srcs:
    s.close()
print(f"mosaic {band.shape} from {len(tiles)} tile(s)")

to_ras = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

def project_ring(ring):
    return [to_ras.transform(lon, lat) for lon, lat in ring]

# ---- per-building 90th percentile ----
heights = {}
skipped = 0
for oid, ring in buildings.items():
    poly = Polygon(project_ring(ring))
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty:
        skipped += 1
        continue
    mask = geometry_mask([poly.__geo_interface__], out_shape=band.shape,
                         transform=transform, invert=True)
    vals = band[mask]
    vals = vals[np.isfinite(vals) & (vals > MIN_BUILDING_FT)]
    if len(vals) < 3:
        skipped += 1
        continue
    heights[str(oid)] = round(float(np.percentile(vals, 90)) * FT, 1)
print(f"buildings: {len(heights)} measured, {skipped} skipped (outside tiles or tiny)")

# ---- canopy within bbox + margin, outside footprints ----
x0, y0 = to_ras.transform(west, south)
x1, y1 = to_ras.transform(east, north)
x0, x1 = min(x0, x1) - MARGIN_FT, max(x0, x1) + MARGIN_FT
y0, y1 = min(y0, y1) - MARGIN_FT, max(y0, y1) + MARGIN_FT

inv = ~transform
c0, r1 = inv * (x0, y0)   # note: row grows downward
c1, r0 = inv * (x1, y1)
r0, r1 = max(0, int(r0)), min(band.shape[0], int(np.ceil(r1)))
c0, c1 = max(0, int(c0)), min(band.shape[1], int(np.ceil(c1)))
window = band[r0:r1, c0:c1]

bld_polys = []
for ring in buildings.values():
    p = Polygon(project_ring(ring))
    if not p.is_valid:
        p = p.buffer(0)
    if not p.is_empty:
        bld_polys.append(p.__geo_interface__)
inside_bld = geometry_mask(bld_polys, out_shape=band.shape, transform=transform, invert=True)[r0:r1, c0:c1]

canopy_mask = np.isfinite(window) & (window * FT >= CANOPY_MIN_M) & ~inside_bld

canopy = []
dropped = 0
B = CANOPY_BLOCK_CELLS
cell_ft = transform.a  # 5 ft
for br in range(0, canopy_mask.shape[0], B):
    for bc in range(0, canopy_mask.shape[1], B):
        blk = canopy_mask[br:br + B, bc:bc + B]
        n = int(blk.sum())
        if n < blk.size * CANOPY_MIN_FRACTION:
            continue
        hvals = window[br:br + B, bc:bc + B][blk]
        h_m = float(np.percentile(hvals, 90)) * FT
        if h_m > CANOPY_MAX_M:
            dropped += 1
            continue
        rows, cols = np.nonzero(blk)
        # centre of the canopied cells, in raster CRS then WGS84
        x = transform.c + (c0 + bc + cols.mean() + 0.5) * cell_ft
        y = transform.f - (r0 + br + rows.mean() + 0.5) * cell_ft
        lon, lat = to_wgs.transform(x, y)
        radius_m = float(np.sqrt(n * (cell_ft * FT) ** 2 / np.pi))
        canopy.append({
            "lat": round(lat, 6), "lon": round(lon, 6),
            "r": round(radius_m, 1),
            "h": round(h_m, 1),
        })
print(f"canopy: {len(canopy)} circles (block {B * cell_ft:.0f} ft, threshold {CANOPY_MIN_M} m), {dropped} dropped over {CANOPY_MAX_M} m")

# ---- where the tiles actually hold data, so the app can keep OSM trees elsewhere ----
def wgs_box(b):
    """Inner lat/lon box of a raster bound: never claim more than every corner shares."""
    corners = [to_wgs.transform(x, y) for x in (b.left, b.right) for y in (b.bottom, b.top)]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    return {
        "south": round(max(lats[0], lats[2]), 6), "north": round(min(lats[1], lats[3]), 6),
        "west": round(max(lons[0], lons[1]), 6), "east": round(min(lons[2], lons[3]), 6),
    }

coverage = [wgs_box(b) for b in tile_bounds]
for c in coverage:
    print(f"coverage tile: lat {c['south']}..{c['north']}, lon {c['west']}..{c['east']}")

out = {
    "_generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "_source": "Indiana 2017-2019 3DEP lidar NDHM, " + ", ".join(Path(t).name for t in tiles),
    "buildings": heights,
    "canopy": canopy,
    "coverage": coverage,
}
dest = ROOT / "public/campus-heights.json"
dest.write_text(json.dumps(out))
print(f"wrote {dest}")

sample = sorted(heights.items(), key=lambda kv: -kv[1])[:8]
print("tallest:", ", ".join(f"{k}:{v}m" for k, v in sample))
