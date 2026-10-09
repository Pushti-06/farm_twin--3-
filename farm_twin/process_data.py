"""
Aggregates the real district-level crop dataset (Crop-Datasets-for-All-Indian-States,
sourced from data.gov.in via GitHub) up to State + Year level for a focused set of
major crops. Summing area/production across districts and recomputing yield keeps
every number traceable back to real recorded district figures.

Run once:
    python process_data.py
Produces: data/crop_yield_by_state_year.csv
"""

import csv
from collections import defaultdict

CROPS = {
    "RICE": ("RICE AREA (1000 ha)", "RICE PRODUCTION (1000 tons)"),
    "WHEAT": ("WHEAT AREA (1000 ha)", "WHEAT PRODUCTION (1000 tons)"),
    "MAIZE": ("MAIZE AREA (1000 ha)", "MAIZE PRODUCTION (1000 tons)"),
    "SUGARCANE": ("SUGARCANE AREA (1000 ha)", "SUGARCANE PRODUCTION (1000 tons)"),
    "COTTON": ("COTTON AREA (1000 ha)", "COTTON PRODUCTION (1000 tons)"),
    "GROUNDNUT": ("GROUNDNUT AREA (1000 ha)", "GROUNDNUT PRODUCTION (1000 tons)"),
    "SOYABEAN": ("SOYABEAN AREA (1000 ha)", "SOYABEAN PRODUCTION (1000 tons)"),
}


def to_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def main():
    # {(crop, state, year): [total_area, total_production]}
    agg = defaultdict(lambda: [0.0, 0.0])

    with open("data/crops_data.csv", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            state = row["State Name"].strip()
            year = row["Year"].strip()
            for crop, (area_col, prod_col) in CROPS.items():
                area = to_float(row.get(area_col))
                prod = to_float(row.get(prod_col))
                key = (crop, state, year)
                agg[key][0] += area
                agg[key][1] += prod

    out_rows = []
    for (crop, state, year), (area, prod) in agg.items():
        if area <= 0:
            continue  # crop not grown in this state, skip
        yield_kg_per_ha = round((prod * 1000) / area, 2)  # production is in 1000 tons, area in 1000 ha
        out_rows.append({
            "Crop": crop,
            "State": state,
            "Year": int(year),
            "Area_1000ha": round(area, 2),
            "Production_1000tons": round(prod, 2),
            "Yield_kg_per_ha": yield_kg_per_ha,
        })

    out_rows.sort(key=lambda r: (r["Crop"], r["State"], r["Year"]))

    with open("data/crop_yield_by_state_year.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["Crop", "State", "Year", "Area_1000ha", "Production_1000tons", "Yield_kg_per_ha"])
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Wrote {len(out_rows)} state-year-crop rows to data/crop_yield_by_state_year.csv")


if __name__ == "__main__":
    main()
