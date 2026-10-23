"""
District-level observed digital twin: real, changing observations (satellite + live weather) kept
next to - and clearly separated from - the simulated soil-water state and the model's prediction.

State per district (data/twin_state.json):
  observed.satellite   latest Sentinel-2 / MODIS NDVI-EVI-LSWI, acquisition dates, NDVI anomaly vs the
                       2000-2019 same-period MODIS climatology, status text ("Sentinel-2 3 days old" ...)
  observed.weather     rain last 14/30 days vs normal, dry days, hot days, ET0, window dates (Open-Meteo)
  simulated            soil-water balance (digital_twin.py)   <- simulation, not a measurement
  predicted            yield for the district's main crop + model version + its typical test error
  alert                level (none/watch/warning/critical) + evidence
  data_freshness       per-source timestamps and ages

Refresh: weather every 6 h, satellite (+ prediction) every 24 h via APScheduler (start_scheduler),
or on demand via refresh_all(). Missing data stays None; the UI shows "no satellite observation".
"""

import json
import os
import pickle
import threading
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

import alerts
import fiware_client
from digital_twin import DigitalTwin, HEAT_STRESS_TEMP_C
from fiware_config import district_entity_id
from satellite_aggregate import agri_year, aggregate_year_season, ndvi_anomaly, season_of
from tn_districts import PARENT, TN_DISTRICTS, data_district
from weather import get_recent_history, get_trailing_year_summary

STATE_FILE = "data/twin_state.json"
LIVE_JSON = "data/tn_satellite_live.json"
CLIM_CSV = "data/tn_ndvi_climatology.csv"
NORMALS_JSON = "data/tn_weather_normals.json"
BUNDLE = "model/tn_model.pkl"
REPORT = "model/tn_model_report.json"
TRAINING_CSV = "data/training_data.csv"
HISTORY_FILE = "data/twin_history.jsonl"
_SEASON_LABEL = {"Kharif": "Kharif / Samba (Jun-Nov)", "Rabi": "Rabi (Dec-Mar)", "Summer": "Summer (Apr-May)"}
_hist_last = {}

_lock = threading.RLock()
STATE = {}
_cache = {}


def _cached(path, loader):
    """Load a file, reloading only when its mtime changes."""
    if not os.path.exists(path):
        return None
    m = os.path.getmtime(path)
    hit = _cache.get(path)
    if hit and hit[0] == m:
        return hit[1]
    val = loader(path)
    _cache[path] = (m, val)
    return val


def _json(path):
    return _cached(path, lambda p: json.load(open(p)))


def _now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Weather indicators (pure, testable)
# ---------------------------------------------------------------------------

def rain_indicators(history, rain_doy, today):
    """history: [{date, precipitation, temp_max, et0}] (Open-Meteo daily). rain_doy: list[366] of mean
    mm/day normals (None where unknown) or None. Only COMPLETE days (before `today`) are used.

    Returns dict(actual_14, normal_14, actual_30, normal_30, dry_days, heat_days_5, et0_7, window_start,
    window_end, last_temp_max). Normals/actuals are None when not computable - never zero-filled."""
    days = sorted((d for d in history if d.get("date") and date.fromisoformat(d["date"]) < today), key=lambda d: d["date"])
    if not days:
        return None

    def window(n):
        w = days[-n:]
        if len(w) < n or any(d.get("precipitation") is None for d in w):
            return None, None
        actual = sum(d["precipitation"] for d in w)
        normal = None
        if rain_doy:
            vals = [rain_doy[date.fromisoformat(d["date"]).timetuple().tm_yday - 1] for d in w]
            if all(v is not None for v in vals):
                normal = sum(vals)
        return actual, normal

    a14, n14 = window(14)
    a30, n30 = window(30)
    dry = 0
    for d in reversed(days):
        if d.get("precipitation") is None or d["precipitation"] >= 1.0:
            break
        dry += 1
    last5 = days[-5:]
    heat = sum(1 for d in last5 if d.get("temp_max") is not None and d["temp_max"] >= HEAT_STRESS_TEMP_C)
    et0_7 = [d["et0"] for d in days[-7:] if d.get("et0") is not None]
    return {"actual_14": a14, "normal_14": n14, "actual_30": a30, "normal_30": n30, "dry_days": dry,
            "heat_days_5": heat, "et0_7": round(sum(et0_7), 1) if et0_7 else None,
            "window_start": days[0]["date"], "window_end": days[-1]["date"], "last_temp_max": days[-1].get("temp_max")}


def satellite_status(sat, today):
    """Human-readable data status for the UI, from one district's live snapshot entry (or None)."""
    if not sat:
        return {"text": "no satellite observation", "level": "missing", "age_days": None}
    s2, modis = sat.get("sentinel2") or {}, sat.get("modis")
    if s2.get("ndvi") is not None and s2.get("last_acquisition"):
        age = (today - date.fromisoformat(s2["last_acquisition"])).days
        return {"text": f"Sentinel-2 {age} day{'s' if age != 1 else ''} old", "level": "ok" if age <= 10 else "stale", "age_days": age}
    reason = {"no_scene": "no Sentinel-2 scene in 16 days", "no_cloud_free_cropland": "no cloud-free Sentinel-2 scene in 16 days"}.get(s2.get("status"))
    if modis and modis.get("date"):
        age = (today - date.fromisoformat(modis["date"])).days
        return {"text": f"{reason or 'no Sentinel-2 value'}; latest MODIS composite {age} days old", "level": "stale", "age_days": age}
    return {"text": reason or "no satellite observation", "level": "missing", "age_days": None}


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

def primary_crop(district):
    """Crop with the largest recorded area in the district's most recent years (uses the parent for new districts)."""
    df = _cached(TRAINING_CSV, pd.read_csv)
    if df is None:
        return None
    g = df[df["District"] == data_district(district)]
    if g.empty:
        return None
    g = g[g["Year"] >= g["Year"].max() - 4]
    return g.groupby("Crop")["Area_ha"].sum().idxmax()


def predict_district(district, today=None, trailing_weather=None, kharif_sat=None):
    """Yield forecast for the district's main crop with the deployed model. Returns a dict that always has
    `yield_kg_ha` (None when it cannot be computed) and a `reason`/`notes` explaining the basis."""
    from tn_features import SAT_BASE, SAT_FEATURES, add_satellite_features
    today = today or date.today()
    bundle = _cached(BUNDLE, lambda p: pickle.load(open(p, "rb")))
    base = {"yield_kg_ha": None, "crop": None, "model_version": None, "typical_error_pct": None, "fitted_through": None, "notes": []}
    if bundle is None:
        return {**base, "reason": "model not trained (run train_tn_model.py)"}
    base.update(model_version=bundle["version"], typical_error_pct=bundle.get("typical_error_pct"), fitted_through=bundle["fitted_through"])

    crop = primary_crop(district)
    train = _cached(TRAINING_CSV, pd.read_csv)
    hist = train[(train["District"] == data_district(district)) & (train["Crop"] == crop)].sort_values("Year") if crop else None
    if crop is None or hist is None or hist.empty:
        return {**base, "reason": "no yield history for this district"}
    base["crop"] = crop

    ys = hist["Yield_kg_per_ha"].tolist()
    last_year = int(hist["Year"].iloc[-1])
    row = {"crop": crop, "district": data_district(district), "year": today.year,
           "yield_lag1": ys[-1], "yield_lag2": ys[-2] if len(ys) > 1 else np.nan,
           "hist_mean": float(np.mean(ys)), "hist_n": len(ys)}
    stale = today.year - last_year
    if stale > 1:
        base["notes"].append(f"yield history ends in {last_year}: lag features are {stale} years old, so this is a rough indication")

    w = trailing_weather
    if w is None:
        return {**base, "reason": "no weather summary available"}
    row.update(avg_temp=w["avg_temp"], total_rainfall=w["total_rainfall"], total_et0=w["total_et0"])

    feats = bundle["features"]
    df = pd.DataFrame([row])
    if any(f in SAT_FEATURES for f in feats):
        ky = today.year if today >= date(today.year, 12, 1) else today.year - 1
        df["year"] = ky
        if kharif_sat is None or kharif_sat.empty:
            return {**base, "reason": f"no satellite observation for the Kharif {ky} window"}
        df = add_satellite_features(df, kharif_sat[["district", "year"] + SAT_BASE], clim=bundle["satellite_climatology"])
        if df[SAT_FEATURES[0]].isna().any():
            return {**base, "reason": f"no satellite observation for the Kharif {ky} window"}
        base["notes"].append(f"uses the completed Kharif {ky} (Jun-Nov) satellite window")
    X = df[feats].copy()
    cats = [c for c in ("crop", "district") if c in feats]
    X[cats] = bundle["encoder"].transform(X[cats])
    pred = float(np.exp(bundle["model"].predict(X.astype(float))[0]))
    return {**base, "yield_kg_ha": round(pred, 1), "reason": None}


def _kharif_rows(district, today):
    """Aggregated cached MODIS Kharif rows for the latest completed window (offline-safe)."""
    import satellite_gee
    recs = [r for r in satellite_gee.load_cached("modis") if r["district"] == district]
    if not recs:
        return pd.DataFrame()
    agg = aggregate_year_season(recs, "modis")
    return agg[(agg.season == "Kharif") & (agg.n_obs > 0)]


# ---------------------------------------------------------------------------
# State building
# ---------------------------------------------------------------------------

def _empty(district):
    lat, lon = TN_DISTRICTS[district]
    return {"district": district, "lat": lat, "lon": lon, "polygon_source": f"parent:{PARENT[district]}" if district in PARENT else "own",
            "observed": {"satellite": None, "weather": None}, "simulated": None,
            "predicted": None, "alert": {"level": "none", "evidence": [], "message": "no data yet"},
            "data_freshness": {}, "updated_at": None}


def crop_season(today=None):
    """Current agricultural season and year (agri year Y runs Jun Y - May Y+1)."""
    today = today or date.today()
    name = season_of(today)
    return {"season": name, "label": _SEASON_LABEL[name], "agri_year": agri_year(today)}


def read_history(district=None, limit=None):
    """Retained observation/prediction snapshots (oldest first), optionally for one district."""
    if not os.path.exists(HISTORY_FILE):
        return []
    rows = []
    with open(HISTORY_FILE, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if district is None or r.get("district") == district:
                rows.append(r)
    return rows[-limit:] if limit else rows


def history_snapshot(s, today=None):
    """One compact, comparable record of the district twin: what was observed, predicted and flagged."""
    today = today or date.today()
    sat = (s.get("observed") or {}).get("satellite") or {}
    s2, modis = sat.get("sentinel2") or {}, sat.get("modis") or {}
    use_s2 = s2.get("ndvi") is not None
    src = s2 if use_s2 else modis
    anom = sat.get("anomaly") or {}
    wx = (s.get("observed") or {}).get("weather") or {}
    pred = s.get("predicted") or {}
    cs = s.get("crop_season") or crop_season(today)
    return {"date": today.isoformat(), "district": s["district"], "season": cs["season"], "agri_year": cs["agri_year"],
            "satellite_source": ("sentinel2" if use_s2 else "modis") if src.get("ndvi") is not None else None,
            "satellite_date": (s2.get("last_acquisition") if use_s2 else modis.get("date")) if src.get("ndvi") is not None else None,
            "ndvi": src.get("ndvi"), "evi": src.get("evi"), "lswi": src.get("lswi"),
            "ndvi_anomaly_pct": anom.get("pct"), "ndvi_anomaly_z": anom.get("z"),
            "rain_30": wx.get("actual_30"), "soil_water_mm": (s.get("simulated") or {}).get("soil_water_mm"),
            "predicted_crop": pred.get("crop"), "predicted_yield": pred.get("yield_kg_ha"),
            "alert_level": (s.get("alert") or {}).get("level")}


def log_history(district, s, today=None):
    """Appends a snapshot when something changed (new day, new satellite date, new prediction, new alert level)."""
    snap = history_snapshot(s, today)
    key = (snap["date"], snap["satellite_date"], snap["predicted_yield"], snap["alert_level"])
    with _lock:
        if district not in _hist_last:
            prev = read_history(district, limit=1)
            _hist_last[district] = (prev[0]["date"], prev[0]["satellite_date"], prev[0]["predicted_yield"], prev[0]["alert_level"]) if prev else None
        if _hist_last[district] == key:
            return None
        with open(HISTORY_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(snap) + "\n")
        _hist_last[district] = key
    return snap


def recompute_alert(district):
    """Re-evaluates the alert from whatever observed data the state currently holds, logs + pushes it."""
    s = STATE[district]
    sat = s["observed"].get("satellite") or {}
    wx = s["observed"].get("weather") or {}
    anom = sat.get("anomaly")
    modis = sat.get("modis") or {}
    result = alerts.evaluate_alert(
        ndvi_anomaly=anom, ndvi_date=modis.get("date"), ndvi_source="MODIS MOD13Q1 vs 2000-2019 same-period normal",
        rain=wx if wx else None, dry_days=wx.get("dry_days") if wx else None, heat_days_5=wx.get("heat_days_5") if wx else None,
        soil_drought=(s.get("simulated") or {}).get("drought_risk"), weather_date=wx.get("window_end") if wx else None)
    s["alert"] = result
    s["updated_at"] = _now().isoformat(timespec="seconds")
    s["crop_season"] = crop_season()
    crop = (s.get("predicted") or {}).get("crop")
    alerts.record_alert(district, crop, result, s["data_freshness"])
    log_history(district, s)
    s["fiware_connected"] = fiware_client.upsert_district_entity(district_entity_id(district), s)


def refresh_weather(district):
    lat, lon = TN_DISTRICTS[district]
    hist = get_recent_history(lat, lon, days=31)
    today = date.today()
    normals = (_json(NORMALS_JSON) or {}).get(data_district(district)) or (_json(NORMALS_JSON) or {}).get(district)
    ind = rain_indicators(hist, normals["rain_doy"] if normals else None, today) if hist else None
    twin = DigitalTwin(f"district:{district}", crop="district")
    if hist:
        twin.update_state([d for d in hist if d.get("date") and date.fromisoformat(d["date"]) < today])
    sim = twin.simulate() if hist else None
    with _lock:
        s = STATE.setdefault(district, _empty(district))
        s["observed"]["weather"] = ind
        s["simulated"] = sim
        s["data_freshness"]["weather"] = {"fetched_at": _now().isoformat(timespec="seconds"),
                                          "latest_data_date": ind["window_end"] if ind else None,
                                          "status": "ok" if ind else "weather service unreachable"}
        recompute_alert(district)


def refresh_satellite(district, snapshot, with_prediction=True):
    today = date.today()
    clim = _cached(CLIM_CSV, pd.read_csv)
    rec = ((snapshot or {}).get("districts") or {}).get(district)
    sat = None
    if rec:
        modis = rec.get("modis")
        anom = None
        if modis and clim is not None:
            anom = ndvi_anomaly(modis["ndvi"], date.fromisoformat(modis["date"]), district, clim)
            if anom:
                anom["ndvi"] = modis["ndvi"]
        sat = {"sentinel2": rec.get("sentinel2"), "modis": modis, "anomaly": anom, "status": satellite_status(rec, today),
               "polygon_source": rec.get("polygon_source")}
    pred = None
    if with_prediction:
        try:
            lat, lon = TN_DISTRICTS[district]
            tw = get_trailing_year_summary(lat, lon)
            pred = predict_district(district, today, tw, _kharif_rows(district, today))
        except Exception as e:  # one district failing must not stop the refresh
            pred = {"yield_kg_ha": None, "reason": f"prediction failed: {e}", "notes": []}
    with _lock:
        s = STATE.setdefault(district, _empty(district))
        s["observed"]["satellite"] = sat
        if pred is not None:
            s["predicted"] = pred
        gen = (snapshot or {}).get("generated_at")
        s["data_freshness"]["satellite"] = {
            "snapshot_at": gen, "status": (sat or {}).get("status", {}).get("text", "no satellite observation"),
            "age_days": (sat or {}).get("status", {}).get("age_days")}
        recompute_alert(district)


def load_live_snapshot(allow_gee=True):
    """Fresh GEE snapshot when GEE is configured and reachable, otherwise the last cached one (offline mode)."""
    if allow_gee and os.environ.get("GEE_PROJECT"):
        try:
            import satellite_gee
            return satellite_gee.live_snapshot(satellite_gee.init_ee())
        except Exception as e:
            print(f"GEE live refresh failed ({e}); using the cached snapshot")
    return _json(LIVE_JSON)


def refresh_weather_all():
    for d in sorted(TN_DISTRICTS):
        try:
            refresh_weather(d)
        except Exception as e:
            print(f"weather refresh failed for {d}: {e}")
    save_state()


def refresh_satellite_all(allow_gee=True):
    snap = load_live_snapshot(allow_gee)
    for d in sorted(TN_DISTRICTS):
        try:
            refresh_satellite(d, snap)
        except Exception as e:
            print(f"satellite refresh failed for {d}: {e}")
    save_state()


def refresh_all(allow_gee=True):
    refresh_weather_all()
    refresh_satellite_all(allow_gee)


# ---------------------------------------------------------------------------
# Persistence / access / scheduling
# ---------------------------------------------------------------------------

def save_state():
    with _lock:
        tmp = STATE_FILE + ".tmp"
        json.dump({"saved_at": _now().isoformat(timespec="seconds"), "districts": STATE}, open(tmp, "w"), default=str)
        os.replace(tmp, STATE_FILE)


def load_state():
    if os.path.exists(STATE_FILE):
        with _lock:
            STATE.update(json.load(open(STATE_FILE)).get("districts", {}))


def get_state(district):
    with _lock:
        return STATE.get(district)


def summary():
    """Compact per-district list for maps/beacons."""
    with _lock:
        out = []
        for d in sorted(TN_DISTRICTS):
            s = STATE.get(d)
            sat = ((s or {}).get("observed") or {}).get("satellite") or {}
            out.append({"district": d, "lat": TN_DISTRICTS[d][0], "lon": TN_DISTRICTS[d][1],
                        "level": (s or {}).get("alert", {}).get("level", "none") if s else "unknown",
                        "satellite_status": (sat.get("status") or {}).get("text", "no satellite observation"),
                        "updated_at": (s or {}).get("updated_at")})
        return out


def model_info():
    return _json(REPORT) or {"error": "model not trained (run train_tn_model.py)"}


_scheduler = None


def start_scheduler(initial_refresh=True):
    """Weather every 6 h, satellite every 24 h (APScheduler). Safe to call once at app start."""
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    load_state()
    from apscheduler.schedulers.background import BackgroundScheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(refresh_weather_all, "interval", hours=6, id="weather", max_instances=1, coalesce=True)
    _scheduler.add_job(refresh_satellite_all, "interval", hours=24, id="satellite", max_instances=1, coalesce=True)
    _scheduler.start()
    if initial_refresh:
        threading.Thread(target=refresh_all, kwargs={"allow_gee": False}, daemon=True).start()
    return _scheduler
