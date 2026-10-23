"""
Builds daily-rainfall normals per district (2000-2019, NASA POWER) so the live twin can
say whether the last 14/30 days were wetter or drier than usual for the same dates.

    python build_tn_weather.py

Produces data/tn_weather_normals.json:
    {district: {"rain_doy": [mean mm/day for day-of-year 1..366], "years": [2000, 2019]}}
Needs internet (one NASA POWER call per district). Resumable: finished districts are kept.
(The per-year yield-model weather features come from build_training_dataset.py, unchanged.)
"""

import json
import os
import time
from datetime import date

import numpy as np
import requests

from tn_districts import TN_DISTRICTS
from weather import _fetch_history

OUT = "data/tn_weather_normals.json"
YEARS = (2000, 2019)


def daily_rain_normal(dates, rain):
    """Mean rainfall (mm/day) per day-of-year 1..366 from a daily series; NaN-safe.
    Days with no observation in any year stay None (not zero)."""
    sums, counts = np.zeros(366), np.zeros(366)
    for d, p in zip(dates, rain):
        if p is None:
            continue
        doy = date.fromisoformat(d).timetuple().tm_yday
        sums[doy - 1] += p
        counts[doy - 1] += 1
    return [round(float(s / c), 3) if c else None for s, c in zip(sums, counts)]


def main():
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    todo = [d for d in sorted(TN_DISTRICTS) if d not in data]
    print(f"{len(data)} districts cached, fetching {len(todo)}")
    for i, d in enumerate(todo, 1):
        lat, lon = TN_DISTRICTS[d]
        try:
            dates, _t, rain, _e = _fetch_history(lat, lon, date(YEARS[0], 1, 1), date(YEARS[1], 12, 31))
        except (requests.exceptions.RequestException, KeyError, ValueError) as e:
            print(f"  {d}: failed ({e}); re-run to resume")
            break
        data[d] = {"rain_doy": daily_rain_normal(dates, rain), "years": list(YEARS)}
        json.dump(data, open(OUT, "w"))
        print(f"  [{i}/{len(todo)}] {d} ok")
        time.sleep(1.0)
    print(f"{len(data)}/{len(TN_DISTRICTS)} districts in {OUT}")


if __name__ == "__main__":
    main()
