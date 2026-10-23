"""Leakage and feature construction. Tiny synthetic tables - never production data."""
import numpy as np
import pandas as pd
import pytest

import tn_features as tf


def training_df(target_override=None):
    rows = []
    for y in range(2008, 2020):
        yld = 1000.0 + 10 * (y - 2008)
        if target_override is not None and y == 2018:
            yld = target_override
        rows.append({"crop": "RICE", "district": "SALEM", "year": y, "area_ha": 10.0, "production_t": 1.0,
                     "yield": yld, "avg_temp": 28.0, "total_rainfall": 800.0, "total_et0": 1500.0})
    return pd.DataFrame(rows)


def sat_df(overrides=None):
    rows = []
    for y in range(2008, 2020):
        v = overrides.get(y, 0.6 + 0.01 * (y - 2008)) if overrides else 0.6 + 0.01 * (y - 2008)
        rows.append({"district": "SALEM", "year": y, "ndvi_max": v, "ndvi_mean": v - 0.2, "ndvi_sum": v * 100,
                     "evi_mean": v - 0.3, "lswi_mean": v - 0.4})
    return pd.DataFrame(rows)


def test_lags_use_only_earlier_years():
    df = tf.add_history_features(training_df())
    r = df[df.year == 2015].iloc[0]
    assert r.yield_lag1 == 1000 + 10 * 6 and r.yield_lag2 == 1000 + 10 * 5
    assert r.hist_mean == pytest.approx(np.mean([1000 + 10 * i for i in range(7)]))   # 2008..2014
    assert r.hist_n == 7
    first = df[df.year == 2008].iloc[0]
    assert np.isnan(first.hist_mean) and np.isnan(first.yield_lag1) and first.hist_n == 0


def test_target_year_yield_never_changes_its_own_features():
    a = tf.add_history_features(training_df())
    b = tf.add_history_features(training_df(target_override=99999.0))
    ra, rb = a[a.year == 2018].iloc[0], b[b.year == 2018].iloc[0]
    for c in ["yield_lag1", "yield_lag2", "hist_mean", "hist_n"]:
        assert ra[c] == rb[c] or (np.isnan(ra[c]) and np.isnan(rb[c]))
    # later years legitimately see it as history
    assert a[a.year == 2019].iloc[0].yield_lag1 != b[b.year == 2019].iloc[0].yield_lag1


def test_lag_is_nan_when_previous_year_missing():
    df = training_df()
    out = tf.add_history_features(df[df.year != 2014])
    assert np.isnan(out[out.year == 2015].iloc[0].yield_lag1)      # no silent shift to 2013


def test_climatology_uses_train_years_only():
    base = tf.satellite_climatology(sat_df(), train_end=2014)
    changed = tf.satellite_climatology(sat_df(overrides={2016: 0.01, 2018: 0.02}), train_end=2014)
    pd.testing.assert_frame_equal(base["mean"], changed["mean"])
    pd.testing.assert_frame_equal(base["std"], changed["std"])


def test_anomaly_baseline_not_shaped_by_test_years():
    df = tf.add_history_features(training_df())
    a = tf.add_satellite_features(df, sat_df(), train_end=2014)
    b = tf.add_satellite_features(df, sat_df(overrides={2018: 0.05}), train_end=2014)
    assert a[a.year == 2012].iloc[0].ndvi_max_anom == pytest.approx(b[b.year == 2012].iloc[0].ndvi_max_anom)
    assert a[a.year == 2018].iloc[0].ndvi_max_anom != b[b.year == 2018].iloc[0].ndvi_max_anom


def test_new_district_uses_parent_satellite_and_climatology():
    df = training_df()
    df["district"] = "TENKASI"                      # parent: TIRUNELVELI
    s = sat_df()
    s["district"] = "TIRUNELVELI"
    out = tf.add_satellite_features(tf.add_history_features(df), s, train_end=2014)
    assert out["ndvi_max"].notna().all() and out["ndvi_max_anom"].notna().all()


def test_no_satellite_gives_nan_columns_not_zeros():
    empty = pd.DataFrame(columns=["district", "year"] + tf.SAT_BASE)
    out = tf.add_satellite_features(tf.add_history_features(training_df()), empty)
    assert out[tf.SAT_FEATURES].isna().all().all()


def test_split_is_temporal_and_disjoint():
    tr, va, te = tf.split(tf.add_history_features(training_df()))
    assert tr.year.max() <= 2014 and va.year.between(2015, 2016).all() and te.year.between(2017, 2019).all()
    assert not set(tr.index) & set(te.index)


def test_models_are_compared_to_naive_baselines_on_same_rows():
    import train_tn_model as t
    df = tf.add_satellite_features(tf.add_history_features(training_df()), sat_df(), train_end=2014)
    tr, _, te = tf.split(df)
    res, preds = t.evaluate(tr, te, {"csv_only": tf.FEATURE_SETS["csv_only"]})
    assert {"baseline_last_year", "baseline_district_crop_mean"} <= set(res)
    assert len({v["n"] for v in res.values()}) == 1 and len(preds) == res["baseline_last_year"]["n"]
