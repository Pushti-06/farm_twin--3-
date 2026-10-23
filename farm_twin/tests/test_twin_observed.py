"""Weather indicators, data-status text, and offline satellite rebuild from cached exports."""
import json
from datetime import date, timedelta

import pytest

import satellite_gee
import twin_observed as T


def hist(rain, start=date(2024, 8, 1), tmax=30.0):
    return [{"date": (start + timedelta(days=i)).isoformat(), "precipitation": r, "temp_max": tmax, "et0": 4.0}
            for i, r in enumerate(rain)]


def test_rain_indicators_windows_and_dry_days():
    h = hist([5.0] * 20 + [0.0] * 14)                            # 34 days, last 14 dry
    r = T.rain_indicators(h, [2.0] * 366, date(2024, 8, 1) + timedelta(days=34))
    assert r["actual_14"] == 0 and r["normal_14"] == pytest.approx(28.0)
    assert r["actual_30"] == pytest.approx(5.0 * 16) and r["dry_days"] == 14


def test_today_is_excluded_as_incomplete():
    r = T.rain_indicators(hist([1.0] * 5), None, date(2024, 8, 5))   # last entry is "today"
    assert r["window_end"] == "2024-08-04"


def test_missing_normals_or_data_stay_none():
    r = T.rain_indicators(hist([1.0] * 31), None, date(2024, 9, 5))
    assert r["normal_14"] is None and r["actual_14"] == 14.0
    assert T.rain_indicators(hist([1.0] * 5), None, date(2024, 8, 3))["actual_14"] is None   # window too short
    assert T.rain_indicators([], None, date(2024, 8, 3)) is None


def test_heat_days_counted_from_last_five():
    assert T.rain_indicators(hist([0.0] * 10, tmax=36.0), None, date(2024, 9, 1))["heat_days_5"] == 5


def test_satellite_status_messages():
    today = date(2024, 8, 10)
    ok = {"sentinel2": {"ndvi": 0.5, "last_acquisition": "2024-08-07"}}
    assert T.satellite_status(ok, today)["text"] == "Sentinel-2 3 days old"
    cloudy = {"sentinel2": {"ndvi": None, "status": "no_cloud_free_cropland"}, "modis": None}
    assert T.satellite_status(cloudy, today)["text"] == "no cloud-free Sentinel-2 scene in 16 days"
    assert T.satellite_status(None, today)["text"] == "no satellite observation"
    stale = {"sentinel2": {"ndvi": None, "status": "no_scene"}, "modis": {"date": "2024-08-04", "ndvi": 0.4}}
    assert "MODIS composite 6 days old" in T.satellite_status(stale, today)["text"]


def test_gee_not_configured_gives_clear_error(monkeypatch):
    monkeypatch.delenv("GEE_PROJECT", raising=False)
    with pytest.raises(satellite_gee.GEEUnavailable, match="GEE_PROJECT"):
        satellite_gee.init_ee()


def test_offline_rebuild_from_cached_exports(tmp_path, monkeypatch):
    monkeypatch.setattr(satellite_gee, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(satellite_gee, "YEAR_CSV", str(tmp_path / "year.csv"))
    monkeypatch.setattr(satellite_gee, "CLIM_CSV", str(tmp_path / "clim.csv"))
    recs = [{"district": "SALEM", "date": f"{y}-07-10", "ndvi": 0.5 + 0.01 * (y - 2000), "evi": 0.3, "lswi": 0.1,
             "source": "modis"} for y in range(2000, 2012)]
    (tmp_path / "modis_2000.json").write_text(json.dumps(recs))
    df = satellite_gee.rebuild_outputs()
    assert (tmp_path / "year.csv").exists() and (tmp_path / "clim.csv").exists()
    assert set(df.source) == {"modis"} and (df[df.season == "Year"].n_obs > 0).all()


def test_offline_rebuild_with_no_cache_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(satellite_gee, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(satellite_gee, "YEAR_CSV", str(tmp_path / "year.csv"))
    assert satellite_gee.rebuild_outputs() is None and not (tmp_path / "year.csv").exists()


def test_boundary_name_matching_and_parent_fallback():
    m, rep = satellite_gee.match_boundaries(["KANCHIPURAM", "CHENGALPATTU", "THE NILGIRIS", "NOWHERE"],
                                            ["Kancheepuram", "Nilgiris"])
    assert m["KANCHIPURAM"][0] == "Kancheepuram" and m["THE NILGIRIS"][0] == "Nilgiris"
    assert m["CHENGALPATTU"][1].startswith("parent:") and rep["NOWHERE"]["how"] == "UNMATCHED"


def test_crop_season_labels():
    assert T.crop_season(date(2026, 7, 1)) == {"season": "Kharif", "label": "Kharif / Samba (Jun-Nov)", "agri_year": 2026}
    assert T.crop_season(date(2027, 1, 15))["season"] == "Rabi" and T.crop_season(date(2027, 1, 15))["agri_year"] == 2026
    assert T.crop_season(date(2027, 4, 10))["season"] == "Summer"


def test_history_is_retained_and_deduplicated(tmp_path, monkeypatch):
    monkeypatch.setattr(T, "HISTORY_FILE", str(tmp_path / "h.jsonl"))
    monkeypatch.setattr(T, "_hist_last", {})
    s = {"district": "VELLORE", "observed": {"satellite": {"modis": {"date": "2026-08-01", "ndvi": 0.6, "evi": 0.3, "lswi": 0.1}}, "weather": {}},
         "simulated": {"soil_water_mm": 80}, "predicted": {"crop": "RICE", "yield_kg_ha": 3900.0}, "alert": {"level": "none"}}
    d = date(2026, 8, 2)
    assert T.log_history("VELLORE", s, d) is not None
    assert T.log_history("VELLORE", s, d) is None                         # nothing changed
    s["observed"]["satellite"]["modis"] = {"date": "2026-08-17", "ndvi": 0.65, "evi": 0.3, "lswi": 0.1}
    assert T.log_history("VELLORE", s, d) is not None                     # new satellite date is retained
    h = T.read_history("VELLORE")
    assert [x["ndvi"] for x in h] == [0.6, 0.65] and h[0]["season"] == "Kharif" and h[0]["predicted_yield"] == 3900.0
    s2 = {"district": "ERODE", "observed": {"satellite": None, "weather": None}, "simulated": None, "predicted": None, "alert": {"level": "none"}}
    snap = T.log_history("ERODE", s2, d)
    assert snap["ndvi"] is None and snap["satellite_source"] is None      # missing stays None
