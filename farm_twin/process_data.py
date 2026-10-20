"""
Cleans and aggregates the Tamil Nadu district-level crop dataset
(data/tamil_nadu_crop_yield.csv: district x year x season x crop, area in ha,
production in tonnes) up to District + Year + Crop level.

The raw file needs cleaning before it is usable:
  * Many records appear twice, the second copy with Production inflated by an
    exact power of ten (x100 is typical), and most 2014-2019 records are only
    present at the inflated scale. We estimate each crop's true yield scale from
    the records that exist at both scales, then divide inflated rows back down.
  * Coconut is measured in nuts (not tonnes) and the file contains aggregate
    rows ("Total foodgrain", "Pulses total") - both are dropped.
  * Rows that still fall outside a plausible yield range for their crop are
    dropped rather than guessed at.

Summing area and production across seasons, then recomputing yield, keeps every
figure traceable to recorded district numbers.

Run once:
    python process_data.py
Produces: data/crop_yield_by_district_year.csv
"""

import csv
import math
import statistics
from collections import defaultdict

from tn_districts import DISTRICT_ALIASES, TN_DISTRICTS

RAW_FILE = "data/tamil_nadu_crop_yield.csv"
OUT_FILE = "data/crop_yield_by_district_year.csv"

EXCLUDED_CROPS = {"Coconut", "Total foodgrain", "Pulses total"}
CROP_RENAMES = {
    "Cotton(lint)": "COTTON",
    "Moong(Green Gram)": "MOONG",
    "Arhar/Tur": "ARHAR",
}
MIN_ROWS_PER_CROP = 150     # skip crops too sparse to train on
YIELD_BAND = 4.0            # keep yields within [ref / 4, ref * 4]


def crop_label(raw):
    return CROP_RENAMES.get(raw, raw).upper()


def load_rows():
    rows = []
    with open(RAW_FILE, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r["Crop"] in EXCLUDED_CROPS:
                continue
            try:
                area, prod = float(r["Area"]), float(r["Production"])
            except ValueError:
                continue
            if area < 1 or prod <= 0:
                continue
            district = r["District_Name"].strip().upper()
            district = DISTRICT_ALIASES.get(district, district)
            if district not in TN_DISTRICTS:
                continue
            rows.append({
                "crop": crop_label(r["Crop"]), "district": district,
                "year": int(r["Crop_Year"]), "season": r["Season"].strip(),
                "area": area, "prod": prod,
            })
    return rows


def reference_yields(rows):
    """Per-crop true yield (t/ha): median of the lower-scale copy of every
    record that exists at two scales."""
    groups = defaultdict(list)
    for r in rows:
        groups[(r["district"], r["year"], r["season"], r["crop"], r["area"])].append(r)
    samples = defaultdict(list)
    for g in groups.values():
        if len(g) < 2:
            continue
        lo = min(g, key=lambda r: r["prod"])
        if max(r["prod"] for r in g) / lo["prod"] >= 10:
            samples[lo["crop"]].append(lo["prod"] / lo["area"])
    return {c: statistics.median(v) for c, v in samples.items() if len(v) >= 30}


def main():
    rows = load_rows()
    ref = reference_yields(rows)

    kept, seen = [], set()
    for r in rows:
        if r["crop"] not in ref:
            continue
        y = r["prod"] / r["area"]
        k = max(0, round(math.log10(y / ref[r["crop"]])))   # inflation exponent
        prod = r["prod"] / (10 ** k)
        y = prod / r["area"]
        if not (ref[r["crop"]] / YIELD_BAND <= y <= ref[r["crop"]] * YIELD_BAND):
            continue
        key = (r["district"], r["year"], r["season"], r["crop"], r["area"])
        if key in seen:
            continue                                        # duplicate of an inflated copy
        seen.add(key)
        kept.append({**r, "prod": prod})

    agg = defaultdict(lambda: [0.0, 0.0])
    for r in kept:
        a = agg[(r["crop"], r["district"], r["year"])]
        a[0] += r["area"]
        a[1] += r["prod"]

    out = [
        {"Crop": c, "District": d, "Year": y, "Area_ha": round(a, 1),
         "Production_t": round(p, 1), "Yield_kg_per_ha": round(p * 1000 / a, 1)}
        for (c, d, y), (a, p) in agg.items()
    ]
    rows_per_crop = defaultdict(int)
    for o in out:
        rows_per_crop[o["Crop"]] += 1
    out = [o for o in out if rows_per_crop[o["Crop"]] >= MIN_ROWS_PER_CROP]
    out.sort(key=lambda o: (o["Crop"], o["District"], o["Year"]))

    with open(OUT_FILE, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Crop", "District", "Year", "Area_ha", "Production_t", "Yield_kg_per_ha"])
        w.writeheader()
        w.writerows(out)

    print(f"Read {len(rows)} usable raw rows -> kept {len(kept)} after scale fix/dedupe/outlier filter")
    print(f"Wrote {len(out)} district-year-crop rows to {OUT_FILE}")
    print(f"{len(set(o['Crop'] for o in out))} crops, {len(set(o['District'] for o in out))} districts, "
          f"years {min(o['Year'] for o in out)}-{max(o['Year'] for o in out)}")


if __name__ == "__main__":
    main()
