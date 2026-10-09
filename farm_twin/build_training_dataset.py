"""
Merges the aggregated real crop yield data with real historical weather
(fetched live from Open-Meteo's archive for each State + Year combination),
producing the final dataset the ML model trains on.

This needs internet access and takes a few minutes (one API call per unique
State+Year pair, ~160 calls across 20 states x 8 years — Open-Meteo's free
tier handles this fine). Run once:

    python build_training_dataset.py

Produces: data/training_data.csv
"""

import csv
import time

from state_coordinates import STATE_COORDINATES
from weather import get_historical_year_summary


def main():
    with open("data/crop_yield_by_state_year.csv") as f:
        rows = list(csv.DictReader(f))

    # cache weather per (state, year) so we don't re-fetch it for every crop
    weather_cache = {}
    unique_pairs = sorted({(r["State"], r["Year"]) for r in rows})
    print(f"Fetching real historical weather for {len(unique_pairs)} state-year combinations...")

    for i, (state, year) in enumerate(unique_pairs, 1):
        if state not in STATE_COORDINATES:
            continue
        lat, lon = STATE_COORDINATES[state]
        summary = get_historical_year_summary(lat, lon, year)
        weather_cache[(state, year)] = summary
        status = "ok" if summary else "failed"
        print(f"  [{i}/{len(unique_pairs)}] {state} {year} -> {status}")
        time.sleep(0.3)  # be polite to the free API

    out_rows = []
    for r in rows:
        key = (r["State"], r["Year"])
        w = weather_cache.get(key)
        if not w:
            continue  # skip rows where weather fetch failed, rather than guessing
        out_rows.append({
            **r,
            "Avg_Temp_C": w["avg_temp"],
            "Total_Rainfall_mm": w["total_rainfall"],
            "Total_ET0_mm": w["total_et0"],
        })

    with open("data/training_data.csv", "w", newline="") as f:
        fieldnames = ["Crop", "State", "Year", "Area_1000ha", "Production_1000tons",
                      "Yield_kg_per_ha", "Avg_Temp_C", "Total_Rainfall_mm", "Total_ET0_mm"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"\nWrote {len(out_rows)} rows (crop yield + real historical weather) to data/training_data.csv")


if __name__ == "__main__":
    main()
