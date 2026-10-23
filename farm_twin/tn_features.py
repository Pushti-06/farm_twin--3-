"""
Feature construction for the Tamil Nadu yield model: CSV history (lags), weather and satellite.

Leakage rules (enforced by tests/test_features.py)
  * Yield history features for year Y use only yields of years < Y. The target year's yield is
    never an input, and neither is anything derived from it.
  * Satellite features for year Y are taken from the Kharif window (Jun-Nov of Y) only, i.e.
    observations that exist before the year-Y yield is reported. The Rabi/Summer windows run into
    Y+1 and are exported but deliberately NOT used by the model.
  * Satellite anomalies are measured against each district's own climatology computed from
    TRAIN years only (year <= train_end), so validation/test years never shape their own baseline.
  * Known limitation (inherited from build_training_dataset.py): the weather features are calendar-year
    totals of year Y, which include months after some harvests. This is reported in the README.
"""

import os

import numpy as np
import pandas as pd

from tn_districts import data_district

TRAIN_END = 2014
VAL_YEARS = (2015, 2016)
TEST_YEARS = (2017, 2019)

TRAINING_CSV = "data/training_data.csv"
SATELLITE_CSV = "data/tn_district_satellite_year.csv"
SAT_SEASON = "Kharif"
SAT_SOURCE = "modis"            # the only sensor that spans the whole training history
SAT_BASE = ["ndvi_max", "ndvi_mean", "ndvi_sum", "evi_mean", "lswi_mean"]
SAT_ANOM = [f"{c}_anom" for c in SAT_BASE] + ["ndvi_max_z"]

CATEGORICAL = ["crop", "district"]
CSV_FEATURES = ["yield_lag1", "yield_lag2", "hist_mean", "hist_n"]
WEATHER_FEATURES = ["avg_temp", "total_rainfall", "total_et0"]
SAT_FEATURES = SAT_BASE + SAT_ANOM

FEATURE_SETS = {
    "csv_only": CATEGORICAL + CSV_FEATURES,
    "csv_weather": CATEGORICAL + CSV_FEATURES + WEATHER_FEATURES,
    "csv_weather_satellite": CATEGORICAL + CSV_FEATURES + WEATHER_FEATURES + SAT_FEATURES,
}


def load_training(path=TRAINING_CSV):
    df = pd.read_csv(path).rename(columns={
        "Crop": "crop", "District": "district", "Year": "year", "Area_ha": "area_ha",
        "Production_t": "production_t", "Yield_kg_per_ha": "yield",
        "Avg_Temp_C": "avg_temp", "Total_Rainfall_mm": "total_rainfall", "Total_ET0_mm": "total_et0"})
    return df.sort_values(["crop", "district", "year"]).reset_index(drop=True)


def add_history_features(df):
    """yield_lag1 / yield_lag2 (exactly 1 / 2 calendar years earlier, NaN if that year is missing),
    hist_mean / hist_n (mean and count of ALL earlier years' yields for the district-crop)."""
    df = df.copy()
    key = {(r.district, r.crop, r.year): r.yield_ for r in df.rename(columns={"yield": "yield_"}).itertuples()}
    df["yield_lag1"] = [key.get((d, c, y - 1), np.nan) for d, c, y in zip(df.district, df.crop, df.year)]
    df["yield_lag2"] = [key.get((d, c, y - 2), np.nan) for d, c, y in zip(df.district, df.crop, df.year)]

    hist_mean, hist_n = [], []
    for _, g in df.groupby(["district", "crop"], sort=False):
        g = g.sort_values("year")
        csum = g["yield"].cumsum() - g["yield"]          # sum of strictly earlier rows
        n = np.arange(len(g))
        hist_mean.append(pd.Series(np.where(n > 0, csum / np.maximum(n, 1), np.nan), index=g.index))
        hist_n.append(pd.Series(n, index=g.index))
    df["hist_mean"] = pd.concat(hist_mean).reindex(df.index)
    df["hist_n"] = pd.concat(hist_n).reindex(df.index)
    return df


def load_satellite(path=SATELLITE_CSV, season=SAT_SEASON, source=SAT_SOURCE):
    """District-year satellite table for one season and ONE sensor (never mixed). Empty if absent."""
    if not os.path.exists(path):
        return pd.DataFrame(columns=["district", "year"] + SAT_BASE)
    s = pd.read_csv(path)
    s = s[(s["season"] == season) & (s["source"] == source) & (s["n_obs"] > 0)]
    return s[["district", "year"] + SAT_BASE].copy()


def satellite_climatology(sat, train_end=TRAIN_END):
    """Per-district mean/std of each satellite feature over years <= train_end only."""
    tr = sat[sat["year"] <= train_end]
    g = tr.groupby("district")[SAT_BASE]
    return {"mean": g.mean(), "std": g.std()}


def add_satellite_features(df, sat, clim=None, train_end=TRAIN_END):
    """Join satellite features on (district, year) - using the parent district's observations for
    newly created districts - then add anomalies vs the train-years climatology."""
    df = df.copy()
    if sat.empty:
        for c in SAT_FEATURES:
            df[c] = np.nan
        return df
    clim = clim or satellite_climatology(sat, train_end)
    lookup = sat.set_index(["district", "year"])
    cols = {c: [] for c in SAT_BASE}
    anom = {c: [] for c in SAT_ANOM}
    for d, y in zip(df.district, df.year):
        src = d if (d, y) in lookup.index else data_district(d)
        row = lookup.loc[(src, y)] if (src, y) in lookup.index else None
        cdist = d if d in clim["mean"].index else data_district(d)
        for c in SAT_BASE:
            v = float(row[c]) if row is not None and pd.notna(row[c]) else np.nan
            cols[c].append(v)
            m = clim["mean"][c].get(cdist, np.nan)
            anom[f"{c}_anom"].append(v - m if pd.notna(v) and pd.notna(m) else np.nan)
        sd = clim["std"]["ndvi_max"].get(cdist, np.nan)
        v, m = cols["ndvi_max"][-1], clim["mean"]["ndvi_max"].get(cdist, np.nan)
        anom["ndvi_max_z"].append((v - m) / sd if pd.notna(v) and pd.notna(m) and pd.notna(sd) and sd > 0 else np.nan)
    for c, v in {**cols, **anom}.items():
        df[c] = v
    return df


def build_features(train_csv=TRAINING_CSV, sat_csv=SATELLITE_CSV, train_end=TRAIN_END):
    df = add_history_features(load_training(train_csv))
    return add_satellite_features(df, load_satellite(sat_csv), train_end=train_end)


def split(df):
    """Time split: train <= 2014, validation 2015-16, test 2017-19."""
    return (df[df.year <= TRAIN_END],
            df[(df.year >= VAL_YEARS[0]) & (df.year <= VAL_YEARS[1])],
            df[(df.year >= TEST_YEARS[0]) & (df.year <= TEST_YEARS[1])])
