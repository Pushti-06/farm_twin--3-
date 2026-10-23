"""Aggregation of raw satellite records. Fixtures are tiny hand-made series, not production data."""
from datetime import date

import numpy as np
import pandas as pd
import pytest

from satellite_aggregate import (agri_year, aggregate_year_season, build_climatology, ndvi_anomaly,
                                 season_of, source_coverage)


def rec(d, ndvi, evi=None, lswi=None, district="X"):
    return {"district": district, "date": d, "ndvi": ndvi, "evi": evi, "lswi": lswi}


def test_agri_year_boundary():
    assert agri_year(date(2010, 5, 31)) == 2009
    assert agri_year(date(2010, 6, 1)) == 2010
    assert season_of(date(2010, 12, 1)) == "Rabi" and season_of(date(2011, 3, 31)) == "Rabi"
    assert season_of(date(2010, 7, 1)) == "Kharif" and season_of(date(2011, 4, 1)) == "Summer"


def test_year_season_aggregation_values():
    recs = [rec("2010-06-10", 0.2, 0.1, 0.0), rec("2010-07-10", 0.6, 0.3, 0.2), rec("2010-08-10", 0.4, 0.2, 0.1),
            rec("2011-01-10", 0.5, 0.25, 0.1)]
    df = aggregate_year_season(recs, "modis")
    k = df[(df.year == 2010) & (df.season == "Kharif")].iloc[0]
    assert k.ndvi_max == pytest.approx(0.6) and k.ndvi_mean == pytest.approx(0.4)
    assert k.n_obs == 3 and k.source == "modis"
    assert k.evi_mean == pytest.approx(0.2) and k.lswi_mean == pytest.approx(0.1)
    assert k.ndvi_peak_doy == date(2010, 7, 10).timetuple().tm_yday
    # trapezoid over 30 + 31 days
    assert k.ndvi_sum == pytest.approx(0.4 * 30 + 0.5 * 31)
    y = df[(df.year == 2010) & (df.season == "Year")].iloc[0]
    assert y.n_obs == 4 and y.ndvi_max == pytest.approx(0.6)   # Jan 2011 belongs to ag-year 2010


def test_missing_stays_nan_never_filled():
    df = aggregate_year_season([rec("2010-06-10", None), rec("2010-06-26", None)], "modis")
    k = df[(df.season == "Kharif")].iloc[0]
    assert k.n_obs == 0 and np.isnan(k.ndvi_max) and np.isnan(k.ndvi_sum)


def test_empty_input_gives_empty_frame():
    assert aggregate_year_season([], "modis").empty


def test_climatology_and_anomaly():
    recs = [rec(f"{y}-07-05", 0.5 + 0.01 * (y - 2000)) for y in range(2000, 2012)]   # 12 years, same slot
    clim = build_climatology(recs, 2000, 2011)
    a = ndvi_anomaly(0.40, date(2015, 7, 5), "X", clim)
    assert a["clim_mean"] == pytest.approx(np.mean([0.5 + 0.01 * i for i in range(12)]))
    assert a["z"] < -2 and a["pct"] < 0


def test_anomaly_none_when_too_few_years_or_no_spread():
    clim = build_climatology([rec("2000-07-05", 0.5), rec("2001-07-05", 0.5)], 2000, 2001)
    assert ndvi_anomaly(0.3, date(2015, 7, 5), "X", clim) is None          # fewer than min_years
    flat = build_climatology([rec(f"{y}-07-05", 0.5) for y in range(2000, 2012)], 2000, 2011)
    assert ndvi_anomaly(0.3, date(2015, 7, 5), "X", flat) is None          # zero spread
    assert ndvi_anomaly(None, date(2015, 7, 5), "X", flat) is None


def test_source_coverage_counts_per_sensor():
    a = aggregate_year_season([rec("2010-07-10", 0.5)], "modis")
    b = aggregate_year_season([rec("2018-07-10", 0.5), rec("2018-07-10", 0.4, district="Y")], "sentinel2")
    assert source_coverage(pd.concat([a, b])) == {"modis": 1, "sentinel2": 2}
