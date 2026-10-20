"""
Merges the aggregated real crop yield data with real historical weather
(fetched from NASA POWER at each district's headquarters),
producing the final dataset the ML model trains on.

Needs internet access. One API call per district covers all its years (~37
calls, a couple of minutes). Each district's weather is cached in
data/weather_cache.json, so if a download fails just re-run and it resumes:

    python build_training_dataset.py

Produces: data/training_data.csv
"""

import csv
import json
import os
import time

from tn_districts import TN_DISTRICTS
from weather import get_historical_year_summaries

CACHE_FILE = "data/weather_cache.json"


def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            return json.load(f)   # {district: {"year": summary}}
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)


def main():
    with open("data/crop_yield_by_district_year.csv") as f:
        rows = list(csv.DictReader(f))

    years_by_district = {}
    for r in rows:
        years_by_district.setdefault(r["District"], set()).add(int(r["Year"]))

    cache = load_cache()
    todo = [d for d in sorted(years_by_district) if d not in cache]
    print(f"{len(years_by_district) - len(todo)} districts cached, fetching {len(todo)} more...")

    for i, district in enumerate(todo, 1):
        years = years_by_district[district]
        lat, lon = TN_DISTRICTS[district]
        summaries = get_historical_year_summaries(lat, lon, min(years), max(years))
        if not summaries:
            print(f"  {district} -> failed (network or NASA POWER error). "
                  f"Progress is saved; re-run this script to finish.")
            break
        cache[district] = {str(y): w for y, w in summaries.items()}
        save_cache(cache)
        print(f"  [{i}/{len(todo)}] {district} -> ok")
        time.sleep(1.0)  # be polite to the free API

    missing = [d for d in years_by_district if d not in cache]
    if missing:
        print(f"\nStill missing weather for {len(missing)} districts: {', '.join(sorted(missing))}")
        print("Not writing training_data.csv yet - re-run to complete it.")
        return

    out_rows = []
    for r in rows:
        w = cache.get(r["District"], {}).get(r["Year"])
        if not w or w["total_et0"] is None:
            continue  # skip rows where weather is missing, rather than guessing
        out_rows.append({
            **r,
            "Avg_Temp_C": w["avg_temp"],
            "Total_Rainfall_mm": w["total_rainfall"],
            "Total_ET0_mm": w["total_et0"],
        })

    with open("data/training_data.csv", "w", newline="") as f:
        fieldnames = ["Crop", "District", "Year", "Area_ha", "Production_t",
                      "Yield_kg_per_ha", "Avg_Temp_C", "Total_Rainfall_mm", "Total_ET0_mm"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"\nWrote {len(out_rows)} rows (crop yield + real historical weather) to data/training_data.csv")


if __name__ == "__main__":
    main()
