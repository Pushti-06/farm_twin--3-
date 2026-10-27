# Adaptive Digital Twin Framework for Climate-Resilient Smart Agriculture

A hardware-free, sensor-free digital twin for farming in **Tamil Nadu**, built only from open data and open-source software. It forecasts crop yield, tracks crop water status from real weather, checks it against satellite vegetation data, raises graded alerts, and turns the satellite image of a chosen place into an **interactive 3D twin** where you can simulate weather, see which parts of the area are affected, irrigate, change alert thresholds and receive alerts.

*VIT BCSE497J Project-I. Authors: Pushti Singh (23BKT0029) and Harshita.*

---

## Contents

1. [What the project does](#1-what-the-project-does)
2. [The problem it addresses](#2-the-problem-it-addresses)
3. [System architecture](#3-system-architecture)
4. [Data sources](#4-data-sources)
5. [The yield model](#5-the-yield-model)
6. [The twin](#6-the-twin)
7. [Alerts](#7-alerts)
8. [3D place twin and Twin Studio](#8-3d-place-twin-and-twin-studio)
9. [FIWARE Orion](#9-fiware-orion)
10. [Installation and run order](#10-installation-and-run-order)
11. [API reference](#11-api-reference)
12. [Repository layout](#12-repository-layout)
13. [Testing](#13-testing)
14. [Limitations](#14-limitations)
15. [Future work: multi-user registration and e-mail / SMS alerts](#15-future-work-multi-user-registration-and-e-mail--sms-alerts)
16. [Data sources, licences and credits](#16-data-sources-licences-and-credits)

---

## 1. What the project does

| Layer | What it gives you | Main files |
|---|---|---|
| **Yield forecast** | Predicted yield for a district, crop and year, compared with simple baselines | `process_data.py`, `build_training_dataset.py`, `train_tn_model.py` |
| **Adaptive twin** | A soil-water balance that updates from real observed and forecast weather | `digital_twin.py`, `weather.py` |
| **Observed twin** | District state from real satellite NDVI (MODIS history, Sentinel-2 live) and real weather, kept separate from simulated values | `satellite_gee.py`, `twin_observed.py` |
| **Alert engine** | `none / watch / warning / critical` alerts with the evidence behind them | `alerts.py` |
| **FIWARE Orion** | The twin state held as queryable NGSI entities | `fiware_client.py`, `docker-compose.yml` |
| **3D place twin** | Real satellite imagery on real terrain with real buildings, plus a 50 m zone simulator | `static/place3d.js`, `static/place3d_sim.js`, `place_ndvi.py` |
| **Twin Studio** | Full-screen interface: entity list, floating live labels, live-data controls, simulator | `static/studio.html`, `studio.css`, `studio.js` |

Everything that is a model output is labelled **simulated** in the interface. The project does not measure soil moisture and does not prescribe irrigation or fertiliser from satellite data.

## 2. The problem it addresses

Small farms usually have no field sensors, and district-level bulletins hide local differences: it can rain at one village and stay dry ten kilometres away. The project answers three questions with open data only:

1. *What yield should we expect?* (machine-learning model with weather features)
2. *Is the crop under water or heat stress now, and is that confirmed by the satellite?* (soil-water twin + NDVI anomaly + alerts)
3. *Which part of this area is affected, and what happens if the weather changes or we irrigate?* (3D place twin with a zone simulator)

## 3. System architecture

```
 Tamil Nadu crop-yield CSV        Open-Meteo / NASA POWER         Google Earth Engine          Esri imagery, AWS terrain,
 (district, crop, year)           (weather, forecast)             (MODIS, Sentinel-2)          OpenStreetMap buildings
          |                               |                               |                              |
          v                               v                               v                              |
  cleaning + features  ------>   yield model (Random Forest)              |                              |
                                          |                               |                              |
                                          v                               v                              |
                          soil-water twin (150 mm bucket) --> observed twin (scheduler) --> alert engine |
                                          |                               |                    |         |
                                          +---------------+---------------+                    |         |
                                                          v                                    v         v
                                             FIWARE Orion (MongoDB)               Dashboard / Twin / 3D place twin / Twin Studio
```

* **Backend:** Flask. A scheduler (APScheduler) refreshes weather every 6 hours and satellite data every 24 hours. Set `DISABLE_SCHEDULER=1` to turn it off.
* **Front end:** HTML, CSS, JavaScript, Plotly charts, Three.js r128 for 3D.
* **State:** `data/twin_state.json` (observed twin per district), `alerts.jsonl` (alert log), Orion entities.

## 4. Data sources

| Source | Used for | Notes |
|---|---|---|
| Tamil Nadu district crop-yield CSV (`data/tamil_nadu_crop_yield.csv`) | Model training | 31,312 raw rows, 1997 to 2019 |
| NASA POWER | Historical daily weather for training | Free, no key |
| Open-Meteo | Live weather, 16-day forecast, ET0, rainfall normals | Free for non-commercial use, no key |
| Google Earth Engine, **MODIS MOD13Q1** | NDVI history 2000 to 2019: training features and the same-period normal for anomalies | 250 m, 16-day |
| Google Earth Engine, **Sentinel-2 SR Harmonized** | Live NDVI at 10 to 20 m, and per-zone NDVI for the 3D place twin | Cloud-masked with the Scene Classification Layer |
| Esri World Imagery, AWS Terrain Tiles (Terrarium), OpenStreetMap via Overpass | Imagery, terrain and building footprints for the 3D place twin | Streamed to the browser |

Every row of `data/tn_district_satellite_year.csv` has a `source` column, so MODIS and Sentinel-2 are never mixed silently. Missing values stay empty; nothing is filled in.

## 5. The yield model

**Cleaning (`process_data.py`).** The raw file repeats many records with production inflated by a power of ten (typically 100), and most 2014 to 2019 rows exist only at the inflated scale. The script estimates each crop's true yield scale from records present at both scales and divides the inflated rows back down. It drops coconut (counted in nuts), aggregate rows, rows with area below 1 ha or no production, and rows with a yield outside one quarter to four times the crop's reference yield, and it skips crops with fewer than 150 rows. Area and production are summed over seasons and the yield recomputed. **Result: 14,806 district-crop-year rows, 37 districts, 30 crops, 1997 to 2019.**

**Training (`train_tn_model.py`).**
* Target: log of yield (kg/ha). Algorithms: Random Forest and histogram gradient boosting.
* Time split: train up to 2014 (11,208 rows), validation 2015 to 2016 (1,418 rows), test 2017 to 2019 (2,180 rows, 1,980 scored).
* Feature sets: `csv_only` (crop, district, last two yields, historical mean and count), `csv_weather` (adds mean temperature, rainfall, ET0), `csv_weather_satellite` (adds MODIS Kharif NDVI features).
* Baselines on the same rows: last year's yield, and the district-and-crop average.
* The configuration with the lowest **validation** error is deployed.
* Leakage controls (tested): history features use strictly earlier years only; satellite features use the Kharif window of the same year only; satellite anomalies use a training-years-only normal.

**Results on 2017 to 2019 (1,980 rows), from `model/tn_model_report.json`:**

| Model | MAPE % | MAE kg/ha | RMSE (log) | R² (log) |
|---|---|---|---|---|
| Baseline: last year | 34.0 | 2,101 | 0.511 | 0.908 |
| Baseline: district-and-crop average | 31.2 | 1,898 | 0.412 | 0.941 |
| Random Forest, crop only | 31.4 | 1,619 | 0.390 | 0.947 |
| Gradient boosting, crop only | 31.5 | 1,656 | 0.379 | 0.950 |
| **Random Forest, crop + weather (deployed)** | **31.1** | **1,632** | **0.389** | **0.947** |
| Gradient boosting, crop + weather | 31.3 | 1,698 | 0.376 | 0.950 |

How to read this honestly: the models reduce the absolute error by about 11 to 15% against the best baseline, but the percentage error is almost the same (31.1 to 31.5% against 31.2%). R² on log yield is high mostly because yields differ by orders of magnitude between crops. Weather features did not give a clear gain, and a three-year test period means differences of a few percent are within noise.

> **Status of the satellite-trained model.** The third feature set (crop + weather + satellite) is defined but **was skipped in the recorded run** because `data/tn_district_satellite_year.csv` had not been generated yet. Run `python satellite_gee.py history` and then `python train_tn_model.py` to train it; the report file will then record the comparison. Until then, satellite data is used for the observed twin, the NDVI anomaly and the alerts, not for the yield model.

## 6. The twin

### 6.1 Soil-water twin (`digital_twin.py`)
One root-zone store with a capacity of **150 mm**. Each day: add rainfall, subtract crop evapotranspiration (ET0 × crop coefficient × a water-stress factor), remove drainage and runoff when full. **Drought** is flagged below 40 mm, **heat stress** at a daily maximum of 35 °C or more. The start state is built from the last 14 days of real weather and the 16-day forecast is applied day by day.

### 6.2 Observed twin (`twin_observed.py`)
Per district: latest satellite NDVI/EVI/LSWI, anomaly against the 2000 to 2019 same-period MODIS normal (z-score and percent), rainfall over 14 and 30 days against normal, consecutive dry days, hot days, and per-source data freshness. The simulated soil-water flag and the model's prediction are stored next to it but kept visibly separate.

## 7. Alerts

`alerts.py` scores observed indicators and returns a level with the evidence list (indicator, value, date, source):

| Indicator | Points |
|---|---|
| NDVI vs normal: z ≤ −2 or ≤ −20% / z ≤ −1.5 or ≤ −12% / z ≤ −1 or ≤ −7% | 3 / 2 / 1 |
| Rainfall vs normal (worse of 14 and 30 days): ratio ≤ 0.40 / ≤ 0.60 | 2 / 1 |
| 14 or more consecutive dry days (< 1 mm) | 1 |
| 35 °C or more on 3 of the last 5 days | 1 |
| Simulated soil-water drought flag (labelled simulated) | 1 |

Level: 1 to 2 points **watch**, 3 to 4 **warning**, 5 or more **critical**. A warning needs at least two indicators; a critical needs NDVI stress plus another indicator, otherwise the level is capped one step lower. Alerts are de-duplicated for 24 hours and appended to `alerts.jsonl`. They state what was observed and suggest checking in the field; **they never prescribe irrigation or fertiliser from NDVI alone.**

**Delivery today.** Warning and critical alerts can be sent to **one** configured recipient by e-mail (SMTP) and/or Telegram, using environment variables (see [Installation](#10-installation-and-run-order)). Failures never affect the twin. Sending to many registered users is the future work in [section 15](#15-future-work-multi-user-registration-and-e-mail--sms-alerts).

## 8. 3D place twin and Twin Studio

For the selected place (a 1.5 km × 1.5 km box) the browser draws **real Esri satellite imagery on real elevation data with real OpenStreetMap buildings**. Green vegetation is found from the image colours (excess-green index) so only vegetation is coloured by the twin.

### 8.1 Zone simulator (`static/place3d_sim.js`)
The scene is divided into **30 × 30 zones of 50 m**. Each zone starts from measured inputs: image greenness, built-up share from building footprints, terrain height, the twin's soil-water state and, when available, the Sentinel-2 NDVI of that zone. A daily water balance then runs forward: rain (less on built-up land), runoff received from the higher neighbouring zone, irrigation, crop water use, drainage, and excess water routed downhill to the lowest neighbouring zone. Crop vigour falls under drought, heat or waterlogging and recovers slowly in good conditions.

What you can do:

* **Weather:** the real 16-day Open-Meteo forecast, or what-if scenarios: dry spell, heatwave, heavy rain, cyclone, custom sliders (30 days).
* **Time:** drag the day slider or press **Play**.
* **Layers:** soil water, crop vigour, drought, waterlogging, irrigation.
* **Inspect a zone:** soil water, vigour, and what is driving it (rain, runoff received, irrigation, crop water use) with a graph against the drought threshold.
* **Irrigate:** click zones (brush of 1, 9 or 25 zones, 10 to 60 mm every third day) or irrigate all zones that reach drought, and watch the alerts clear.
* **Thresholds:** drought (mm), heat (°C), days of waterlogging and the share of green land that makes a warning are all sliders; alerts update immediately.
* **Alerts:** `watch / warning / critical` for drought, heat, waterlogging and crop-vigour loss, shown as a list, a banner over the scene and pulsing pillars on the affected zones. Export as CSV; zones export as CSV or GeoJSON.
* **Observed vs simulated:** compares the district satellite anomaly and the per-zone Sentinel-2 vigour with the simulation, and says when they disagree.

Waterlogging is not raised for rice (grown in standing water) and needs real excess water (at least 8 mm of rain or runoff on a day the soil is full).

### 8.2 Per-zone satellite input (`place_ndvi.py`)
`/api/place-ndvi` takes the last 30 days of Sentinel-2, masks cloud, shadow, cirrus and snow with the Scene Classification Layer, takes the median NDVI, averages it to 50 m and returns the grid (cached 6 hours). The browser sets each green zone's starting vigour to `(NDVI − 0.15) / 0.65`, limited to 0.05 to 1. If Earth Engine is not set up or no cloud-free scene exists, the simulator falls back to image greenness adapted by the district anomaly and shows the reason.

### 8.3 Twin Studio (`static/studio.html`)
A full-screen layout: entity list and active alerts on the left, the 3D scene with **floating live data labels** in the middle (place summary, worst drought / waterlogged / heat-stress zones, selected zone), and live-data controls on the right (endpoint, refresh interval of manual / 30 s / 1 min / 5 min, auto refresh, view modes, simulator). Auto refresh re-reads `/api/twin-state` and re-runs the simulation, so the twin follows new weather.

Open **http://127.0.0.1:5000/static/studio.html** after starting the app. The classic page at `/twin` also contains the 3D place twin.

## 9. FIWARE Orion

The twin state is published to the Orion Context Broker (NGSI-v2) so it can be queried by any FIWARE-compatible tool.

| Entity | ID | Content |
|---|---|---|
| `FarmTwin` | `urn:ngsi-ld:FarmTwin:<District>:<Crop>` | soil water, fill %, dry days, drought risk, heat stress, status, predicted yield |
| `DistrictTwin` | `urn:ngsi-ld:DistrictTwin:<Name>` | observed satellite and weather state, alert level, freshness |

Entities are created on first write (`options=upsert`). If Orion is not running the app falls back to local computation and the badge on the Twin page says which is in use.

## 10. Installation and run order

**Requirements:** Python 3 (3.11 was used), a browser with WebGL, Docker Desktop (optional, for Orion), a Google Earth Engine non-commercial project (optional, for satellite data).

```powershell
# Windows PowerShell, inside the farm_twin folder
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt

docker compose up -d                 # optional: Orion + MongoDB
python process_data.py               # clean and aggregate the crop CSV
python build_training_dataset.py     # add real yearly weather
python build_tn_weather.py           # daily rainfall normals per district
```

**Satellite data (one-time Earth Engine setup):**

1. Register a free **non-commercial** project at <https://earthengine.google.com/noncommercial/>.
2. `earthengine authenticate`
3. `$env:GEE_PROJECT="<your-project-id>"` (PowerShell) or `set GEE_PROJECT=<id>` (cmd).

```powershell
python satellite_gee.py all          # MODIS history, Sentinel-2, live snapshot
python train_tn_model.py             # ablations vs baselines -> model/tn_model_report.json
python app.py                        # http://127.0.0.1:5000
```

`python satellite_gee.py history --offline` rebuilds the CSVs from cached exports without Earth Engine.

**Environment variables**

| Variable | Purpose |
|---|---|
| `GEE_PROJECT` | Earth Engine project id (satellite data and `/api/place-ndvi`) |
| `DISABLE_SCHEDULER=1` | Run without background refresh |
| `ALERT_LOG` | Alert log path (default `alerts.jsonl`) |
| `SMTP_HOST`, `ALERT_EMAIL_TO`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_PORT`, `ALERT_EMAIL_FROM` | E-mail delivery of warning and critical alerts to one recipient |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram delivery to one chat |

**Open in the browser:** `/` dashboard, `/twin` digital twin, `/static/studio.html` Twin Studio.

## 11. API reference

| Endpoint | Method | Returns |
|---|---|---|
| `/api/predict` | POST | Yield forecast, recommendation and twin state for `{district, crop, area}` |
| `/api/twin-state` | GET | Current twin state, location, weather, recent weather |
| `/api/tn/districts` | GET | Summary of all districts |
| `/api/tn/district/<NAME>` | GET | Observed state, satellite anomaly, alert, data freshness |
| `/api/tn/history/<NAME>` | GET | Stored history of a district |
| `/api/alerts` | GET | Recent alerts (`?district=`, `?limit=`) |
| `/api/model-info` | GET | Model report (metrics, split, deployed configuration) |
| `/api/tn/refresh` | POST / GET | Starts a background refresh |
| `/api/place-ndvi` | GET | Per-zone Sentinel-2 NDVI grid for `?lat=&lon=&half=` |

## 12. Repository layout

```
farm_twin/
  app.py                     Flask app and API
  process_data.py            clean + aggregate the crop CSV
  build_training_dataset.py  add yearly weather
  build_tn_weather.py        daily rainfall normals
  tn_features.py             feature sets and leakage controls
  train_tn_model.py          model training and report
  digital_twin.py            soil-water balance
  twin_observed.py           observed twin and scheduler
  alerts.py                  alert rules, log, delivery
  satellite_gee.py           Earth Engine pipeline
  satellite_aggregate.py     district/year/season aggregation
  place_ndvi.py              per-zone Sentinel-2 NDVI endpoint
  fiware_client.py, fiware_config.py, docker-compose.yml
  recommendation.py, weather.py, tn_districts.py
  templates/                 base, dashboard, twin
  static/                    dashboard.js, twin.js, observed.js, landscape.js, geo.*,
                             place3d.js/css, place3d_sim.js, studio.html/css/js
  data/                      raw + cleaned CSVs, twin state, caches
  model/                     tn_model_report.json, tn_test_predictions.csv, yield_model.pkl
  tests/                     pytest suite
```

## 13. Testing

```powershell
pytest
```

36 unit tests run without network or Earth Engine and cover aggregation, feature building (including leakage), alert rules and the observed twin. The 3D place twin and Twin Studio were exercised in an automated headless browser against a mock server (synthetic tiles, forecast and buildings): scene build, scenarios, drought alert and irrigation clearing it, threshold changes, zone inspection, data refresh, CSV/GeoJSON export and no console errors. The per-zone Sentinel-2 call itself needs a real Earth Engine project and has to be checked on a machine that has one.

## 14. Limitations

* **Simulated, not measured.** Soil water and zone alerts are model outputs. One root-zone capacity (150 mm) and one crop coefficient are used; soil type, rooting depth and crop stage are not modelled.
* **No satellite-trained yield model yet** (see section 5). The yield forecast uses crop history and weather.
* **Rainfall is one value per location.** Forecast services give one value for the 1.5 km box, so the "10 km away it is sunny" problem applies between places, not between zones of one box. Observed rainfall at 5 to 10 km (CHIRPS, GPM IMERG) is future work.
* **District-level satellite anomaly.** The anomaly is a cropland-masked district mean; per-zone NDVI comes from the latest cloud-free Sentinel-2 composite, which can be days old and is missing in persistent monsoon cloud.
* **Sensor differences.** MODIS (250 m) and Sentinel-2 (10 to 20 m) differ in scale and bias; anomalies use MODIS history only.
* **Imagery is an archived mosaic.** Esri imagery does not change with each satellite pass; only the NDVI grid does.
* **Satellite season.** The yield features use the Kharif window for all crops.
* **Cropland mask.** ESA WorldCover 2020 is applied to all years.
* **New districts** (Chengalpattu, Kallakurichi, Ranipet, Tirupathur, Tenkasi, Tiruppur) use their parent's polygon and yield history.
* **Yield data ends in 2019,** so lag features for a current-year forecast are several years old (flagged in the interface).
* **No ground validation.** No farmer reports or soil-moisture probes were available to validate zone-level alerts.

## 15. Future work: multi-user registration and e-mail / SMS alerts

*Status: planned, not implemented.* Today the app runs for one operator and can alert **one** configured e-mail address or Telegram chat. The next step is to let many users register and receive alerts for their own district, crop and location.

### 15.1 Goals
1. Users create an account and say where their farm is, what they grow and how they want to be contacted.
2. When the alert engine raises a warning or critical alert, every user subscribed to that district (and crop) is notified by their chosen channel.
3. Users see only their own farm, alerts and settings; an administrator sees all.

### 15.2 Channels, easiest first

| Order | Channel | Why / cost | Notes |
|---|---|---|---|
| 1 | **E-mail (SMTP)** | Free. Already partly implemented in `alerts.py` with `smtplib` | Use any SMTP service (a Gmail app password is enough for a demo). Sends from one sender to many recipients. |
| 2 | **Telegram bot** | Free. Already implemented for one chat | Each user starts the bot once so it learns their chat id; works well on phones. |
| 3 | **SMS** | Paid per message, needs an account with a provider (for example Twilio, MSG91 or Fast2SMS) | In India, transactional SMS normally requires sender and template registration (DLT) with the provider, which takes time; plan for it. Keep messages short and in the user's language. |
| Later | WhatsApp Business, push notifications | Needs business verification | Out of scope for the first release. |

Recommended first release: **registration + e-mail + Telegram**, with SMS added behind the same sender interface once a provider account is available.

### 15.3 Proposed design

**Data model (SQLite first, PostgreSQL later)**

| Table | Main fields |
|---|---|
| `users` | id, name, email (unique), phone (optional), password hash, role (`farmer` / `officer` / `admin`), language (`en` / `ta`), created at, verified at |
| `farms` | id, user id, district, crop, area (ha), latitude, longitude |
| `subscriptions` | user id, farm id, channel (`email` / `telegram` / `sms`), minimum level (`warning` / `critical`), quiet hours, active |
| `notifications` | id, alert id, user id, channel, status (`sent` / `failed` / `skipped`), error, sent at |

**Registration and login**
* Form with name, e-mail, password, district, crop, area and map pin; optional phone for SMS.
* Passwords stored only as salted hashes (`werkzeug.security`), sessions with Flask-Login, CSRF protection on forms.
* E-mail verification link before alerts are sent; every message carries an unsubscribe link.

**Alert fan-out**
1. `alerts.py` already produces a de-duplicated alert record. After it is appended to `alerts.jsonl`, a `notify(alert)` step looks up the subscriptions for that district (and crop) whose minimum level is met.
2. For each subscriber, build a short message from the evidence, choose the language, check quiet hours and per-user de-duplication (for example no repeat of the same level within 24 hours), and send through the channel's sender (`send_email`, `send_telegram`, `send_sms`).
3. Write one `notifications` row per attempt. A failure on one user or channel never blocks the others or the twin.
4. The 3D place twin can offer a "notify me when this zone crosses a threshold" option that saves the user's thresholds with the subscription.

**Message content.** Same rule as the dashboard: say what was observed and ask the user to verify in the field, for example: `[WARNING] Vellore (Rice): NDVI -14% vs normal; rain 45% of normal over 30 days. Please check your field. Reply STOP to unsubscribe.` No irrigation or fertiliser quantities are sent.

**Privacy and security.** Store only what is needed (e-mail, optional phone, farm location); keep secrets (SMTP, bot token, SMS keys) in environment variables, never in the repository; rate-limit registration and login; never show one user's contact details to another; give users a way to delete their account and data.

### 15.4 Work plan

| Step | Work | Output |
|---|---|---|
| 1 | Database, user and farm models, registration, login, e-mail verification | Working accounts |
| 2 | Subscription settings page (district, crop, channel, minimum level) | Per-user preferences |
| 3 | Fan-out step in `alerts.py` with e-mail and Telegram senders, notification log | Alerts to many users |
| 4 | Admin view of users, alerts and delivery status | Operations view |
| 5 | SMS sender with a provider, template registration, cost limits | SMS alerts |
| 6 | Tests: registration, fan-out rules, de-duplication, failure isolation, unsubscribe | Pytest suite |

**Acceptance tests:** two users in different districts receive only their own district's alerts; a user with minimum level `critical` is not sent a `warning`; the same alert is not sent twice within 24 hours; a failing SMTP server does not stop the Telegram message or the twin refresh; an unsubscribed user receives nothing.

### 15.5 Other planned work
* Train the yield model with satellite features once the MODIS table is generated, and report the three-way comparison.
* Add observed rainfall at 5 to 10 km (CHIRPS, GPM IMERG) to the twin.
* Use crop-season-specific satellite windows instead of Kharif for all crops.
* Calibrate the soil-water model with soil data and validate zone alerts against ground observations.
* Extend to other states.

## 16. Data sources, licences and credits

* Crop-yield records: Tamil Nadu district-level data, 1997 to 2019, as provided with the project.
* Weather: NASA POWER and Open-Meteo (open, non-commercial use).
* Satellite: MODIS MOD13Q1 (NASA LP DAAC), Copernicus Sentinel-2 via Google Earth Engine (free for non-commercial research; a commercial service needs a commercial licence).
* Imagery and maps: Esri World Imagery (© Esri, Maxar, Earthstar Geographics), AWS Terrain Tiles, OpenStreetMap contributors (ODbL), Three.js.
* FIWARE Orion Context Broker and MongoDB (Docker images).
