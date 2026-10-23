"""
Satellite pipeline on Google Earth Engine (GEE).

  python satellite_gee.py history            # MODIS MOD13Q1 2000-2019 -> training features
  python satellite_gee.py sentinel-history   # Sentinel-2 2017-2019 (small-sample baseline only)
  python satellite_gee.py live               # latest Sentinel-2 16-day window + latest MODIS composite
  python satellite_gee.py all                # everything above
  python satellite_gee.py history --offline  # rebuild the CSVs from cached exports, no GEE needed

One-time setup
--------------
 1. Register a (free) non-commercial Earth Engine project: https://earthengine.google.com/noncommercial/
 2. pip install earthengine-api
 3. earthengine authenticate
 4. set GEE_PROJECT=<your-gcp-project-id>        (Windows cmd)   /  $env:GEE_PROJECT="<id>" (PowerShell)

Sensors (never mixed silently - every row carries a `source` column)
  modis      MOD13Q1 v061, 250 m, 16-day, 2000-present: training history + live anomaly baseline
  sentinel2  COPERNICUS/S2_SR_HARMONIZED, 10-20 m: finer live view (and a 2017-2019 baseline only)
Cropland only: ESA WorldCover 2020 class 40 (a static map, so for 2000-2019 it is an approximation
of where crops grow, not a record of what was planted each year).

Outputs
  data/tn_district_satellite_year.csv   district, year, season, source, ndvi_max, ndvi_mean, ndvi_sum,
                                        ndvi_peak_doy, evi_mean, lswi_mean, n_obs
  data/tn_ndvi_climatology.csv          same-period MODIS NDVI mean/std per district and 16-day slot
  data/tn_satellite_live.json           latest observations (written by `live`)
  data/sat_cache/*.json                 raw exports (re-runs only fetch what is missing)
Missing values stay NaN/None. Nothing is filled in.
"""

import argparse
import difflib
import glob
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from satellite_aggregate import OUT_COLUMNS, aggregate_year_season, build_climatology
from tn_districts import BOUNDARY_NAME_VARIANTS, PARENT, TN_DISTRICTS

CACHE_DIR = "data/sat_cache"
YEAR_CSV = "data/tn_district_satellite_year.csv"
CLIM_CSV = "data/tn_ndvi_climatology.csv"
LIVE_JSON = "data/tn_satellite_live.json"
GEOJSON = "data/tn_districts.geojson"           # optional; used instead of FAO GAUL when present
NAME_OVERRIDES = "data/gaul_name_overrides.json"  # optional {"OUR NAME": "GAUL ADM2_NAME"}
MATCH_REPORT = os.path.join(CACHE_DIR, "district_matches.json")

MODIS_ID = "MODIS/061/MOD13Q1"
S2_ID = "COPERNICUS/S2_SR_HARMONIZED"
WORLDCOVER_ID = "ESA/WorldCover/v200"
CROPLAND_CLASS = 40
MODIS_FIRST_YEAR = 2000
TRAIN_LAST_YEAR = 2019                      # last year covered by the yield CSV
CLIM_YEARS = (2000, 2019)
S2_HISTORY_YEARS = (2017, 2019)
S2_VALID_SCL = (4, 5)                       # vegetation, bare soil. Cloud, shadow, cirrus, snow excluded.


class GEEUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Earth Engine access
# ---------------------------------------------------------------------------

def init_ee():
    project = os.environ.get("GEE_PROJECT")
    if not project:
        raise GEEUnavailable(
            "GEE_PROJECT is not set. One-time setup: register a non-commercial Earth Engine project, "
            "run `earthengine authenticate`, then set GEE_PROJECT to your project id. "
            "To work from already-cached exports use --offline.")
    try:
        import ee
    except ImportError as e:
        raise GEEUnavailable("earthengine-api is not installed: pip install earthengine-api") from e
    try:
        ee.Initialize(project=project)
    except Exception as e:  # ee raises several types (EEException, auth errors, network)
        raise GEEUnavailable(
            f"Earth Engine initialisation failed for project '{project}': {e}. "
            "Run `earthengine authenticate` and check the project is registered for Earth Engine.") from e
    return ee


_RETRYABLE = ("quota", "too many", "429", "rate limit", "timed out", "timeout", "503", "internal error",
              "backend error", "connection")


def with_retry(fn, attempts=6, base_delay=4.0):
    """Calls fn(); retries transient GEE errors (quota, rate limit, timeouts) with exponential backoff."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            msg = str(e).lower()
            if i == attempts - 1 or not any(k in msg for k in _RETRYABLE):
                raise
            delay = base_delay * (2 ** i)
            print(f"  GEE transient error ({str(e)[:90]}...) - retry {i + 1}/{attempts - 1} in {delay:.0f}s")
            time.sleep(delay)


def _norm(name):
    return " ".join(str(name).upper().replace("-", " ").split())


def match_boundaries(our_names, boundary_names, overrides=None):
    """Map each of our district names to a boundary-dataset name.

    Order: explicit override -> exact normalised match -> known spelling variant -> fuzzy match
    (>= 0.82) -> parent district's match. Returns (mapping, report); mapping[district] =
    (boundary_name, how). Anything unmatched is absent - the caller must not invent a polygon.
    """
    overrides = overrides or {}
    by_norm = {_norm(b): b for b in boundary_names}
    mapping, report = {}, {}

    def lookup(d):
        if d in overrides and _norm(overrides[d]) in by_norm:
            return by_norm[_norm(overrides[d])], "override"
        if _norm(d) in by_norm:
            return by_norm[_norm(d)], "exact"
        for v in BOUNDARY_NAME_VARIANTS.get(d, []):
            if _norm(v) in by_norm:
                return by_norm[_norm(v)], "variant"
        close = difflib.get_close_matches(_norm(d), list(by_norm), n=1, cutoff=0.82)
        if close:
            return by_norm[close[0]], f"fuzzy({close[0]})"
        return None, None

    for d in our_names:
        b, how = lookup(d)
        if b:
            mapping[d] = (b, how)
    for d in our_names:
        if d not in mapping and d in PARENT and PARENT[d] in mapping:
            mapping[d] = (mapping[PARENT[d]][0], f"parent:{PARENT[d]}")
    for d in our_names:
        report[d] = {"boundary": mapping[d][0], "how": mapping[d][1]} if d in mapping else {"boundary": None, "how": "UNMATCHED"}
    return mapping, report


def district_collection(ee):
    """FeatureCollection with one feature per TN district: property `district` (our name) and
    `polygon_source` ('own' or 'parent:<X>'). Writes data/sat_cache/district_matches.json for review."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    overrides = json.load(open(NAME_OVERRIDES)) if os.path.exists(NAME_OVERRIDES) else {}

    if os.path.exists(GEOJSON):
        gj = json.load(open(GEOJSON))
        raw = {}
        for f in gj["features"]:
            p = f.get("properties", {})
            name = p.get("district") or p.get("DISTRICT") or p.get("NAME") or p.get("dtname") or p.get("ADM2_NAME")
            if name:
                raw[_norm(name)] = f
        mapping, report = match_boundaries(list(TN_DISTRICTS), [n for n in raw], overrides)
        feats = [ee.Feature(ee.Geometry(raw[_norm(b)]["geometry"]),
                            {"district": d, "polygon_source": "own" if not how.startswith("parent") else how})
                 for d, (b, how) in mapping.items()]
    else:
        gaul = ee.FeatureCollection("FAO/GAUL/2015/level2").filter(ee.Filter.eq("ADM1_NAME", "Tamil Nadu"))
        names = with_retry(lambda: gaul.aggregate_array("ADM2_NAME").getInfo())
        mapping, report = match_boundaries(list(TN_DISTRICTS), names, overrides)
        feats = []
        for d, (b, how) in mapping.items():
            geom = gaul.filter(ee.Filter.eq("ADM2_NAME", b)).geometry()
            feats.append(ee.Feature(geom, {"district": d, "polygon_source": "own" if not how.startswith("parent") else how}))

    json.dump(report, open(MATCH_REPORT, "w"), indent=2)
    unmatched = [d for d, r in report.items() if r["how"] == "UNMATCHED"]
    if unmatched:
        print(f"WARNING: no boundary polygon for {', '.join(unmatched)} - they are skipped (no value invented). "
              f"See {MATCH_REPORT}; add data/gaul_name_overrides.json to fix.")
    if not feats:
        raise GEEUnavailable("No district polygons could be built; see " + MATCH_REPORT)
    return ee.FeatureCollection(feats)


def cropland_mask(ee):
    wc = ee.ImageCollection(WORLDCOVER_ID).first().select("Map")
    return wc.eq(CROPLAND_CLASS).rename("crop").setDefaultProjection(wc.projection())


# ---------------------------------------------------------------------------
# MODIS (training history + live anomaly baseline)
# ---------------------------------------------------------------------------

def _modis_images(ee, start, end):
    """MOD13Q1 composites with NDVI/EVI/LSWI (x0.0001 scaled), quality-masked (SummaryQA <= 1)
    and restricted to pixels that are >= 50% cropland."""
    col = ee.ImageCollection(MODIS_ID).filterDate(start, end)
    proj = col.first().select("NDVI").projection()
    crop_frac = cropland_mask(ee).reduceResolution(ee.Reducer.mean(), bestEffort=True, maxPixels=1024).reproject(proj)
    keep = crop_frac.gte(0.5)

    def prep(img):
        nir = img.select("sur_refl_b02").multiply(0.0001)
        mir = img.select("sur_refl_b07").multiply(0.0001)
        lswi = nir.subtract(mir).divide(nir.add(mir)).rename("lswi")
        ndvi = img.select("NDVI").multiply(0.0001).rename("ndvi")
        evi = img.select("EVI").multiply(0.0001).rename("evi")
        ok = img.select("SummaryQA").lte(1).And(keep)
        out = ndvi.addBands(evi).addBands(lswi).updateMask(ok)
        return out.copyProperties(img, ["system:time_start"])
    return col.map(prep)


def _reduce_collection(ee, col, fc, scale, reducer=None):
    """Per image x district means as a list of dicts (one getInfo call)."""
    reducer = reducer or ee.Reducer.mean()

    def per_image(img):
        day = ee.Date(img.get("system:time_start")).format("YYYY-MM-dd")
        reduced = img.reduceRegions(collection=fc, reducer=reducer, scale=scale, tileScale=4)
        return reduced.map(lambda f: f.set("date", day))
    flat = col.map(per_image).flatten()
    feats = with_retry(lambda: flat.select(["district", "date", "ndvi", "evi", "lswi"], retainGeometry=False).getInfo())["features"]
    out = []
    for f in feats:
        p = f["properties"]
        out.append({"district": p.get("district"), "date": p.get("date"),
                    "ndvi": p.get("ndvi"), "evi": p.get("evi"), "lswi": p.get("lswi")})
    return out


def fetch_modis_year(ee, fc, year):
    """All 16-day MODIS composites of agricultural year `year` (Jun Y - May Y+1), cached."""
    path = os.path.join(CACHE_DIR, f"modis_{year}.json")
    end = date(year + 1, 6, 1)
    if os.path.exists(path) and end <= date.today() - timedelta(days=20):   # complete years are immutable
        return json.load(open(path))
    recs = _reduce_collection(ee, _modis_images(ee, f"{year}-06-01", f"{year + 1}-06-01"), fc, 250)
    for r in recs:
        r["source"] = "modis"
    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump(recs, open(path, "w"))
    return recs


# ---------------------------------------------------------------------------
# Sentinel-2
# ---------------------------------------------------------------------------

def _s2_index_image(ee, col):
    """Median composite of cloud-masked scenes -> ndvi / evi / lswi, cropland only."""
    def mask(img):
        scl = img.select("SCL")
        ok = scl.eq(S2_VALID_SCL[0])
        for c in S2_VALID_SCL[1:]:
            ok = ok.Or(scl.eq(c))
        return img.updateMask(ok)
    med = col.map(mask).median()
    b = lambda n: med.select(n).multiply(0.0001)
    nir, red, blue, swir = b("B8"), b("B4"), b("B2"), b("B11")
    ndvi = nir.subtract(red).divide(nir.add(red)).rename("ndvi")
    evi = nir.subtract(red).multiply(2.5).divide(nir.add(red.multiply(6)).subtract(blue.multiply(7.5)).add(1)).rename("evi")
    lswi = nir.subtract(swir).divide(nir.add(swir)).rename("lswi")
    return ndvi.addBands(evi).addBands(lswi).updateMask(cropland_mask(ee))


def fetch_s2_months(ee, fc, first_year, last_year):
    """Monthly Sentinel-2 median composites per district for agricultural years first..last, cached per month."""
    records = []
    m = date(first_year, 6, 1)
    stop = min(date(last_year + 1, 6, 1), date.today().replace(day=1))
    while m < stop:
        nxt = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
        path = os.path.join(CACHE_DIR, f"s2_{m:%Y-%m}.json")
        if os.path.exists(path):
            records += json.load(open(path))
        else:
            col = ee.ImageCollection(S2_ID).filterDate(m.isoformat(), nxt.isoformat()).filterBounds(fc.geometry())
            if with_retry(lambda: col.size().getInfo()) == 0:
                recs = []
            else:
                img = _s2_index_image(ee, col)
                red = with_retry(lambda: img.reduceRegions(collection=fc, reducer=ee.Reducer.mean(), scale=100,
                                                           tileScale=8).select(["district", "ndvi", "evi", "lswi"],
                                                                               retainGeometry=False).getInfo())
                mid = (m + timedelta(days=14)).isoformat()
                recs = [{"district": f["properties"]["district"], "date": mid, "source": "sentinel2",
                         "ndvi": f["properties"].get("ndvi"), "evi": f["properties"].get("evi"),
                         "lswi": f["properties"].get("lswi")} for f in red["features"]]
            os.makedirs(CACHE_DIR, exist_ok=True)
            json.dump(recs, open(path, "w"))
            records += recs
        print(f"  Sentinel-2 {m:%Y-%m}: {len(records)} records so far")
        m = nxt
    return records


def s2_live_for_district(ee, feature, window_days=16):
    """Latest `window_days` Sentinel-2 view for one district feature (ee.Feature)."""
    end = date.today() + timedelta(days=1)
    start = end - timedelta(days=window_days + 1)
    geom = feature.geometry()
    col = ee.ImageCollection(S2_ID).filterDate(start.isoformat(), end.isoformat()).filterBounds(geom)
    n_scenes = with_retry(lambda: col.size().getInfo())
    if n_scenes == 0:
        return {"status": "no_scene", "n_scenes": 0, "window_start": start.isoformat(), "window_end": (end - timedelta(days=1)).isoformat(),
                "ndvi": None, "evi": None, "lswi": None, "cloud_free_fraction": None,
                "first_acquisition": None, "last_acquisition": None}

    img = _s2_index_image(ee, col)
    crop = cropland_mask(ee)

    def scl_ok(i):
        scl = i.select("SCL")
        ok = scl.eq(S2_VALID_SCL[0])
        for c in S2_VALID_SCL[1:]:
            ok = ok.Or(scl.eq(c))
        return ok.rename("ok")
    any_valid = col.map(scl_ok).max().updateMask(crop)

    stats = ee.Dictionary({
        "vals": img.reduceRegion(ee.Reducer.median(), geom, 100, bestEffort=True, maxPixels=1e9, tileScale=8),
        "cf": any_valid.reduceRegion(ee.Reducer.mean(), geom, 100, bestEffort=True, maxPixels=1e9, tileScale=8),
        "t0": col.aggregate_min("system:time_start"),
        "t1": col.aggregate_max("system:time_start"),
    })
    s = with_retry(lambda: stats.getInfo())
    vals, cf = s["vals"], s["cf"] or {}
    fmt = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat() if ms else None
    ndvi = vals.get("ndvi")
    return {
        "status": "ok" if ndvi is not None else "no_cloud_free_cropland",
        "n_scenes": n_scenes, "window_start": start.isoformat(), "window_end": (end - timedelta(days=1)).isoformat(),
        "ndvi": ndvi, "evi": vals.get("evi"), "lswi": vals.get("lswi"),
        "cloud_free_fraction": cf.get("ok"),
        "first_acquisition": fmt(s["t0"]), "last_acquisition": fmt(s["t1"]),
    }


def live_snapshot(ee):
    fc = district_collection(ee)
    names = with_retry(lambda: fc.aggregate_array("district").getInfo())
    sources = dict(zip(names, with_retry(lambda: fc.aggregate_array("polygon_source").getInfo())))

    # MODIS: the most recent composites (published with a few days' lag)
    start = (date.today() - timedelta(days=48)).isoformat()
    modis_recs = _reduce_collection(ee, _modis_images(ee, start, (date.today() + timedelta(days=1)).isoformat()), fc, 250)
    latest = {}
    for r in sorted(modis_recs, key=lambda r: r["date"]):
        if r["ndvi"] is not None:
            latest[r["district"]] = {"date": r["date"], "ndvi": r["ndvi"], "evi": r["evi"], "lswi": r["lswi"]}

    out = {}
    for d in names:
        print(f"  live Sentinel-2: {d}")
        feat = ee.Feature(fc.filter(ee.Filter.eq("district", d)).first())
        try:
            s2 = s2_live_for_district(ee, feat)
        except Exception as e:   # one failing district must not lose the rest
            s2 = {"status": "error", "error": str(e)[:200], "ndvi": None, "evi": None, "lswi": None}
        out[d] = {"polygon_source": sources[d], "sentinel2": s2, "modis": latest.get(d)}
    snap = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "districts": out}
    json.dump(snap, open(LIVE_JSON, "w"), indent=2)
    return snap


# ---------------------------------------------------------------------------
# CSV assembly from caches (works offline)
# ---------------------------------------------------------------------------

def load_cached(prefix):
    recs = []
    for p in sorted(glob.glob(os.path.join(CACHE_DIR, f"{prefix}_*.json"))):
        recs += json.load(open(p))
    return recs


def rebuild_outputs():
    """Aggregates whatever is cached into the year CSV and the NDVI climatology."""
    modis = load_cached("modis")
    s2 = load_cached("s2")
    frames = []
    if modis:
        frames.append(aggregate_year_season(modis, "modis"))
    if s2:
        frames.append(aggregate_year_season(s2, "sentinel2"))
    if not frames:
        print("No cached satellite exports found - nothing to write. Run without --offline once GEE is set up.")
        return None
    df = pd.concat(frames, ignore_index=True)[OUT_COLUMNS].sort_values(["source", "district", "year", "season"])
    df.to_csv(YEAR_CSV, index=False)
    print(f"Wrote {len(df)} rows to {YEAR_CSV}")
    for src, n in df[(df.season == "Year") & (df.n_obs > 0)].groupby("source").size().items():
        print(f"  {src}: {n} district-years with observations")
    if modis:
        build_climatology(modis, *CLIM_YEARS).to_csv(CLIM_CSV, index=False)
        print(f"Wrote NDVI climatology ({CLIM_YEARS[0]}-{CLIM_YEARS[1]}) to {CLIM_CSV}")
    return df


def run_history(ee, last_year):
    fc = district_collection(ee)
    for year in range(MODIS_FIRST_YEAR, last_year + 1):
        print(f"MODIS agricultural year {year}")
        fetch_modis_year(ee, fc, year)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["history", "sentinel-history", "live", "all"])
    ap.add_argument("--offline", action="store_true", help="do not contact GEE; rebuild outputs from cached exports")
    ap.add_argument("--last-year", type=int, default=TRAIN_LAST_YEAR)
    args = ap.parse_args()

    if args.offline:
        rebuild_outputs()
        return
    try:
        ee = init_ee()
    except GEEUnavailable as e:
        print(f"Earth Engine unavailable: {e}", file=sys.stderr)
        if glob.glob(os.path.join(CACHE_DIR, "*.json")) and args.command != "live":
            print("Falling back to cached exports (offline mode).", file=sys.stderr)
            rebuild_outputs()
            return
        sys.exit(2)

    if args.command in ("history", "all"):
        run_history(ee, args.last_year)
    if args.command in ("sentinel-history", "all"):
        fetch_s2_months(ee, district_collection(ee), *S2_HISTORY_YEARS)
    if args.command in ("history", "sentinel-history", "all"):
        rebuild_outputs()
    if args.command in ("live", "all"):
        snap = live_snapshot(ee)
        ok = sum(1 for v in snap["districts"].values() if v["sentinel2"].get("ndvi") is not None)
        print(f"Live snapshot: {ok}/{len(snap['districts'])} districts with a cloud-free Sentinel-2 value -> {LIVE_JSON}")


if __name__ == "__main__":
    main()
