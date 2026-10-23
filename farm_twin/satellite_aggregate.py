"""
Pure (no Earth Engine) aggregation of raw satellite observations into the
per-district, per-agricultural-year, per-season features the model uses, plus the
same-period NDVI climatology used for live anomaly detection.

Kept separate from satellite_gee.py so it can be unit-tested and re-run offline
from cached exports.

Raw observation record (one per district x composite date), as written by
satellite_gee.py:
    {"district", "date": "YYYY-MM-DD", "ndvi", "evi", "lswi", "source"}
Any index may be None (no valid cropland pixel / cloud-masked) - such records are
skipped for that index, never filled in.

Agricultural year Y runs Jun Y - May Y+1.
"""

from datetime import date

import numpy as np
import pandas as pd

SEASONS = {
    "Kharif": (6, 7, 8, 9, 10, 11),     # Kharif / Samba
    "Rabi": (12, 1, 2, 3),
    "Summer": (4, 5),
    "Year": (6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5),
}

OUT_COLUMNS = ["district", "year", "season", "source", "ndvi_max", "ndvi_mean", "ndvi_sum",
               "ndvi_peak_doy", "evi_mean", "lswi_mean", "n_obs"]


def agri_year(d):
    """Agricultural year a date belongs to (Jun Y - May Y+1 -> Y)."""
    return d.year if d.month >= 6 else d.year - 1


def season_of(d):
    """Non-overlapping season label for a date (Year is handled separately)."""
    for name in ("Kharif", "Rabi", "Summer"):
        if d.month in SEASONS[name]:
            return name


def _valid(x):
    return x is not None and not (isinstance(x, float) and np.isnan(x))


def aggregate_year_season(records, source):
    """Raw composite records -> rows of OUT_COLUMNS. Missing = NaN, never a guess.

    ndvi_sum is the integral of NDVI over the window in NDVI-days, using each
    composite's spacing to the next valid observation (trapezoid on dates), so it
    does not depend on how many composites the sensor happens to provide.
    """
    df = pd.DataFrame.from_records(records)
    if df.empty:
        return pd.DataFrame(columns=OUT_COLUMNS)
    df["date"] = pd.to_datetime(df["date"])
    for c in ("ndvi", "evi", "lswi"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["year"] = df["date"].map(lambda d: agri_year(d.date()))

    rows = []
    for (district, year), g in df.groupby(["district", "year"]):
        for season, months in SEASONS.items():
            w = g[g["date"].dt.month.isin(months)].sort_values("date")
            nd = w.dropna(subset=["ndvi"])
            if nd.empty:
                rows.append({"district": district, "year": year, "season": season, "source": source,
                             "ndvi_max": np.nan, "ndvi_mean": np.nan, "ndvi_sum": np.nan,
                             "ndvi_peak_doy": np.nan, "evi_mean": np.nan, "lswi_mean": np.nan, "n_obs": 0})
                continue
            days = (nd["date"] - nd["date"].iloc[0]).dt.days.to_numpy(dtype=float)
            vals = nd["ndvi"].to_numpy(dtype=float)
            integral = float(np.sum((vals[1:] + vals[:-1]) / 2.0 * np.diff(days))) if len(vals) > 1 else np.nan
            peak = nd.loc[nd["ndvi"].idxmax(), "date"]
            rows.append({
                "district": district, "year": year, "season": season, "source": source,
                "ndvi_max": float(vals.max()), "ndvi_mean": float(vals.mean()), "ndvi_sum": integral,
                "ndvi_peak_doy": int(peak.dayofyear),
                "evi_mean": float(w["evi"].mean()) if w["evi"].notna().any() else np.nan,
                "lswi_mean": float(w["lswi"].mean()) if w["lswi"].notna().any() else np.nan,
                "n_obs": int(len(nd)),
            })
    return pd.DataFrame(rows, columns=OUT_COLUMNS)


def build_climatology(records, year_from, year_to, slot_days=16):
    """Same-period NDVI climatology per district: mean/std of NDVI per day-of-year
    slot (16-day slots, matching the MODIS composite cadence) over year_from..year_to
    (calendar years). Returns DataFrame[district, slot, mean, std, n]."""
    df = pd.DataFrame.from_records(records)
    if df.empty:
        return pd.DataFrame(columns=["district", "slot", "mean", "std", "n"])
    df["date"] = pd.to_datetime(df["date"])
    df["ndvi"] = pd.to_numeric(df["ndvi"], errors="coerce")
    df = df.dropna(subset=["ndvi"])
    df = df[(df["date"].dt.year >= year_from) & (df["date"].dt.year <= year_to)]
    df["slot"] = (df["date"].dt.dayofyear - 1) // slot_days
    g = df.groupby(["district", "slot"])["ndvi"].agg(["mean", "std", "count"]).reset_index()
    g = g.rename(columns={"count": "n"})
    g["std"] = g["std"].fillna(np.nan)
    return g


def slot_of(d, slot_days=16):
    return (d.timetuple().tm_yday - 1) // slot_days


def ndvi_anomaly(ndvi, obs_date, district, climatology, min_years=8):
    """Compare a live NDVI value with the same-period climatology.

    Returns {"z", "pct", "clim_mean", "clim_std", "n"} or None when there is no
    usable climatology (too few years, zero spread) - never a fabricated value.
    """
    if not _valid(ndvi):
        return None
    row = climatology[(climatology["district"] == district) &
                      (climatology["slot"] == slot_of(obs_date))]
    if row.empty:
        return None
    r = row.iloc[0]
    if r["n"] < min_years or not _valid(r["std"]) or r["std"] <= 0 or r["mean"] <= 0:
        return None
    return {
        "z": float((ndvi - r["mean"]) / r["std"]),
        "pct": float((ndvi - r["mean"]) / r["mean"] * 100.0),
        "clim_mean": float(r["mean"]),
        "clim_std": float(r["std"]),
        "n": int(r["n"]),
    }


def source_coverage(sat_df):
    """District-years covered per source, for the README / UI (honest sensor accounting)."""
    year_rows = sat_df[(sat_df["season"] == "Year") & (sat_df["n_obs"] > 0)]
    return {src: int(len(g)) for src, g in year_rows.groupby("source")}
