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
