# Adaptive Digital Twin Framework — Prototype

Hardware-free digital twin for climate-resilient farming in **Tamil Nadu**:
real district-level crop yield data + live weather API + machine learning yield prediction +
an adaptive soil-water simulation, with the **Dashboard** and **Digital
Twin** as two separate pages, matching the report's presentation-layer /
intelligence-layer split.

## Real data sources

- **Historical crop yields**: real district-level data for Tamil Nadu's districts
  (1997-2019, `data/tamil_nadu_crop_yield.csv`). The raw file mixes unit scales
  (many records appear again with Production inflated by x100 or more), so
  `process_data.py` normalises the scale, drops duplicates, aggregate rows and
  coconut (counted in nuts), and rolls it up to district + year + crop.
- **Weather**: [Open-Meteo](https://open-meteo.com) — free, no API key.
  Live current weather for the dashboard, and real historical weather
  (temperature, rainfall, FAO-56 reference evapotranspiration) at each district's
  headquarters, used to train the yield model; the same yearly features over the
  trailing 365 days are used when predicting.

## FIWARE integration

The digital twin's live state (soil water balance, stress flags, status) is
held in **Orion Context Broker** as a `FarmTwin` NGSI entity — this is what
makes it a digital twin in the FIWARE sense: a live, queryable representation
of the farm, not just a variable in memory.

Unlike a sensor-based FIWARE deployment, no IoT Agent is needed here — this
Flask app computes the twin's state itself (from weather + the water-balance
simulation) and pushes it straight into Orion via NGSI-v2, then reads it back
on every page load. If Orion isn't running, the app automatically falls back
to its local computation — the badge on the Digital Twin page always shows
which one is actually happening.

```bash
docker-compose up -d   # starts Orion + MongoDB
```

No provisioning script is needed — entities are created automatically on
first write (`options=upsert`).

## Architecture (matches the report's 5-layer design)

```
Historical dataset (real)    Weather API (real, live)
        |                            |
        v                            v
   Data ingestion & preprocessing (process_data.py, weather.py)
                    |
                    v
              Farm data store (CSV, in-memory at runtime)
                    |
        +-----------+-----------+
        v           v           v
   ML yield     Adaptive     Recommendation
   model      digital twin       engine
  (train_model.py) (digital_twin.py) (recommendation.py)
        \___________|___________/
                    v
             Flask API (app.py)
                    |
        +-----------+-----------+
        v                       v
   Dashboard page          Digital Twin page
   (/ , dashboard.html)    (/twin , twin.html)
```

## Setup

```bash
pip install -r requirements.txt

# 1. Start FIWARE (Orion + MongoDB) — optional but recommended
docker-compose up -d

# 2. Clean + aggregate the Tamil Nadu crop dataset (fast, no internet needed)
python process_data.py

# 3. Fetch real historical weather and merge it in (needs internet, a few min)
python build_training_dataset.py

# 4. Train the yield-prediction model
python train_model.py

# 5. Run the app
python app.py
```

Open http://127.0.0.1:5000 — start on the **Dashboard**, pick a district/crop/area,
get a forecast. Then check the **Digital Twin** tab to see the live simulated
soil-water state built from that same request.

## Files

| File | Purpose |
|---|---|
| `data/tamil_nadu_crop_yield.csv` | Raw real district-level Tamil Nadu crop data (input) |
| `process_data.py` | Cleans it and aggregates to district+year+crop level |
| `tn_districts.py` | Headquarters coordinates of every district, for weather lookups |
| `weather.py` | Open-Meteo wrapper (live + historical) |
| `build_training_dataset.py` | Merges real crop yields with real historical weather |
| `train_model.py` | Trains Random Forest / Gradient Boosting, picks the better one |
| `digital_twin.py` | The adaptive twin: simulated soil-water balance + stress detection |
| `recommendation.py` | Turns twin state + forecast into irrigation/resource advice |
| `app.py` | Flask app: Dashboard and Digital Twin as separate pages |
| `docker-compose.yml` | Orion Context Broker + MongoDB |
| `fiware_config.py` | Entity naming and Orion connection settings |
| `fiware_client.py` | Pushes/reads the twin's state to/from Orion, with fallback |
| `templates/`, `static/` | Frontend (HTML/CSS/JS + Plotly charts + Three.js 3D field) |

## Satellite integration, observed twin and alerts (v2)

The original dashboard/twin flow above is unchanged. On top of it, each Tamil Nadu district now has an
**observed twin**: real satellite and live-weather measurements, kept visibly separate from the simulated
soil-water state and from the ML yield forecast.

```
Sentinel-2 / MODIS (Google Earth Engine) -> cloud + quality mask, cropland mask -> NDVI, EVI, LSWI
   -> per district / agricultural year / season  (data/tn_district_satellite_year.csv)
   -> join with yield CSV + weather -> RandomForest / HistGradientBoosting (temporal holdout)
   -> district entity in Orion (urn:ngsi-ld:DistrictTwin:<Name>) -> dashboard, twin page, 3D map beacons, alerts
```

### One-time Google Earth Engine setup

1. Register a free **non-commercial** Earth Engine project: <https://earthengine.google.com/noncommercial/>
2. `pip install -r requirements.txt` (includes `earthengine-api`)
3. `earthengine authenticate`
4. Set the project id: `set GEE_PROJECT=<your-project-id>` (cmd) or `$env:GEE_PROJECT="<id>"` (PowerShell)

If GEE is not set up, `satellite_gee.py` stops with a clear message; if exports were cached earlier it rebuilds the
CSVs from the cache instead (`--offline`).

### Run order

```bash
python process_data.py            # unchanged: cleaned yield CSV
python build_training_dataset.py  # unchanged: yearly weather features
python build_tn_weather.py        # NEW: daily rainfall normals per district (2000-2019)
python satellite_gee.py all       # NEW: MODIS history, Sentinel-2 2017-19, live snapshot (needs GEE)
python train_tn_model.py          # NEW: ablations vs naive baselines -> model/tn_model_report.json
python app.py                     # scheduler: weather every 6 h, satellite every 24 h; POST /api/tn/refresh
pytest                            # unit tests (no network, no GEE)
```

Optional alert delivery (env vars): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, and/or `SMTP_HOST`, `ALERT_EMAIL_TO`
(`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_PORT`, `ALERT_EMAIL_FROM`). Only warning/critical alerts are sent.
Set `DISABLE_SCHEDULER=1` to run the app without background refresh.

### Sensors - never mixed silently

Every row of `data/tn_district_satellite_year.csv` has a `source` column.

| source | resolution | years | use |
|---|---|---|---|
| `modis` (MOD13Q1 v061) | 250 m, 16-day | 2000-present | training history (the yield CSV spans 1997-2019) and the live NDVI normal |
| `sentinel2` (S2 SR harmonized) | 10-20 m | ~2017-present | finer live view; a 2017-19 baseline only |

Run `python satellite_gee.py history` and the script prints, and `model/tn_model_report.json` records, how many
district-years each source covers (`satellite.district_years_by_source`). Fill in the actual counts from your run;
they are not known until GEE has been run. The Sentinel-2-only model (train 2017-18, test 2019) is reported as a
**small-sample baseline** and is never deployed.

### Model and evaluation

Time split unchanged (train <= 2014, validation 2015-16, test 2017-19). Three ablations (CSV-only, CSV+weather,
CSV+weather+satellite) x two algorithms, always next to two naive baselines (last-year yield, district-crop mean).
All are scored on the same test rows. The deployed configuration is selected on validation, not test.
`model/tn_test_predictions.csv` holds predicted vs actual per test row, and `/api/model-info` serves the report.
Read R2 on log yield cautiously (it is dominated by differences between crops) and judge by whether a model beats
the naive baselines; the report's `interpretation` field says so explicitly, including when satellite features do not help.

Leakage controls (tested in `tests/test_features.py`): history features use strictly earlier years only; satellite
features come from the Kharif window (Jun-Nov of year Y) only; satellite anomalies use each district's
train-years-only climatology.

### Alerts

For each district the twin compares the latest MODIS NDVI with the 2000-2019 same-period normal (z-score and
percent), and combines it with 14/30-day rainfall vs normal, consecutive dry days, heat, and the *simulated*
soil-water flag. Levels: none / watch / warning / critical, with the evidence list (indicator, value, date, source).
Warning needs two indicators; critical needs NDVI stress plus another indicator. Alerts never recommend irrigation or
fertiliser from NDVI alone - they state what was observed and suggest verifying in the field. They are appended to
`alerts.jsonl` (de-duplicated for 24 h) and shown on the dashboard, twin page and as beacons on the 3D Tamil Nadu map.

### Limitations

- **Sensor differences**: MODIS (250 m) and Sentinel-2 (10-20 m) NDVI differ in scale and bias; anomalies are computed
  only against MODIS history. LSWI uses MODIS band 7 (2130 nm), not the 1640 nm band used with Sentinel-2.
- **Cloud cover in the monsoon** (Jun-Nov) can leave no usable Sentinel-2 scene for weeks; the UI then says so
  instead of filling a value.
- **District average, not field level**: cropland-masked district means hide field variation. The cropland mask is the
  2020 ESA WorldCover map, applied to all years.
- **Boundaries and new districts**: districts created after the boundary dataset (Chengalpattu, Kallakurichi, Ranipet,
  Tirupathur, Tenkasi, Tiruppur) use their parent's polygon and yield history (`tn_districts.PARENT`). Check
  `data/sat_cache/district_matches.json` after the first GEE run to confirm the polygon matches.
- **Live yield forecast**: the yield CSV ends in 2019, so lag features for a current-year forecast are several years
  old (flagged in the UI), and yearly weather features are calendar-year totals as in the original pipeline.
- Weather for the existing yield model comes from NASA POWER (historical) and Open-Meteo (live).
