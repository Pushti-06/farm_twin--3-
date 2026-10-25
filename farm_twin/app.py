"""
Flask backend for the Adaptive Digital Twin Framework for Climate-Resilient
Smart Agriculture.

Two separate pages, matching the presentation-layer / intelligence-layer
split in the system architecture:
  /       -> Dashboard: farm profile form, yield prediction, recommendations
  /twin   -> Digital Twin: the live simulated farm state (soil water balance,
             stress flags) and recent real-weather trends

Run:
    pip install -r requirements.txt
    python process_data.py              # once, cleans + aggregates the Tamil Nadu dataset
    python build_training_dataset.py    # once, merges in real historical weather (needs internet)
    python train_model.py               # once, trains the yield model
    python app.py
"""

import csv
import os
import pickle
import threading
from collections import defaultdict
from datetime import datetime

from flask import Flask, render_template, request, jsonify

import math

from tn_districts import TN_DISTRICTS, display_name
from weather import get_current_weather, get_recent_history, get_trailing_year_summary, search_location
from digital_twin import DigitalTwin
from recommendation import generate_recommendation
from fiware_client import is_fiware_reachable, upsert_twin_entity, get_twin_entity
from fiware_config import entity_id_for
import alerts as alert_log
import twin_observed

app = Flask(__name__)
import place_ndvi; place_ndvi.register(app)
import users; users.register(app)

# ---------------------------------------------------------------------------
# Load real data + trained model once at startup
# ---------------------------------------------------------------------------

with open("data/crop_yield_by_district_year.csv") as f:
    YIELD_ROWS = list(csv.DictReader(f))

# A district/crop pair is only offered when it has enough recorded years for the
# historical average and trend chart to mean something (e.g. Chennai only has a
# single banana record, so it is left out).
MIN_YEARS_OF_HISTORY = 8
_years = defaultdict(set)
for r in YIELD_ROWS:
    _years[(r["District"], r["Crop"])].add(r["Year"])
CROPS_BY_DISTRICT = defaultdict(list)
for (d, c), years in sorted(_years.items()):
    if len(years) >= MIN_YEARS_OF_HISTORY:
        CROPS_BY_DISTRICT[d].append(c)
CROPS_BY_DISTRICT = dict(CROPS_BY_DISTRICT)
# districts that have recorded yield data, as (value, label) for the dashboard
DISTRICTS = [(d, display_name(d)) for d in sorted(CROPS_BY_DISTRICT)]
# every district's headquarters, for the 3D map
DISTRICT_MAP = [{"id": d, "name": display_name(d), "lat": lat, "lon": lon} for d, (lat, lon) in sorted(TN_DISTRICTS.items())]

try:
    with open("model/yield_model.pkl", "rb") as f:
        MODEL_BUNDLE = pickle.load(f)
except FileNotFoundError:
    MODEL_BUNDLE = None  # app still runs; dashboard will show a setup message

# in-memory store for the current demo farm (single-farm prototype)
FARM_TWINS = {}       # farm_id -> DigitalTwin instance
LAST_RESULT = None    # most recent full prediction+twin+recommendation result


def historical_avg_yield(district, crop):
    matches = [float(r["Yield_kg_per_ha"]) for r in YIELD_ROWS if r["District"] == district and r["Crop"] == crop]
    return sum(matches) / len(matches) if matches else None


def historical_trend(district, crop):
    matches = sorted(
        [(int(r["Year"]), float(r["Yield_kg_per_ha"])) for r in YIELD_ROWS if r["District"] == district and r["Crop"] == crop]
    )
    return {"years": [m[0] for m in matches], "yields": [m[1] for m in matches]}


def predict_yield(district, crop, avg_temp, total_rainfall, total_et0):
    if MODEL_BUNDLE is None:
        return None
    b = MODEL_BUNDLE
    try:
        crop_enc = b["crop_encoder"].transform([crop])[0]
        district_enc = b["district_encoder"].transform([district])[0]
    except ValueError:
        return None  # crop/district wasn't in training data
    features = [[crop_enc, district_enc, avg_temp, total_rainfall, total_et0]]
    pred = float(b["model"].predict(features)[0])
    return math.exp(pred) if b.get("log_target") else pred


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def dashboard():
    return render_template("dashboard.html", districts=DISTRICTS, crops_by_district=CROPS_BY_DISTRICT, model_ready=MODEL_BUNDLE is not None)


@app.route("/twin")
def twin_page():
    return render_template("twin.html")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.route("/api/search-location")
def api_search_location():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify({"results": []})
    return jsonify({"results": search_location(query)})


@app.route("/api/predict", methods=["POST"])
def api_predict():
    global LAST_RESULT

    body = request.get_json(force=True)
    district = body.get("district")
    crop = body.get("crop")
    area = float(body.get("area", 1.0))

    if crop not in CROPS_BY_DISTRICT.get(district, []):
        return jsonify({"error": f"There isn't enough recorded {crop} yield history for that district. Pick another crop or district."}), 400

    # Exact farm location (geocoded village/town) takes priority over the
    # district-headquarters coordinate fallback — this is what makes weather
    # genuinely local to the farmer's actual field.
    farm_lat = body.get("farm_lat")
    farm_lon = body.get("farm_lon")
    farm_location_name = body.get("farm_location_name")

    if farm_lat is not None and farm_lon is not None:
        lat, lon = float(farm_lat), float(farm_lon)
        location_label = farm_location_name or f"{lat:.4f}, {lon:.4f}"
        used_exact_location = True
    elif district in TN_DISTRICTS:
        lat, lon = TN_DISTRICTS[district]
        location_label = f"{display_name(district)} district (headquarters approximation)"
        used_exact_location = False
    else:
        return jsonify({"error": "Unknown district or farm location"}), 400

    current = get_current_weather(lat, lon)
    recent = get_recent_history(lat, lon, days=14)

    if current is None or not recent:
        return jsonify({"error": "Could not reach the weather service. Check your internet connection and try again."}), 503

    # update (or create) this farm's digital twin from real recent weather
    farm_id = f"{district}:{crop}:{location_label}"
    twin = FARM_TWINS.get(farm_id) or DigitalTwin(farm_id, crop)
    twin.update_state(recent)
    FARM_TWINS[farm_id] = twin
    twin_state = twin.simulate()

    # The model was trained on whole-year weather features, so it is asked about
    # the trailing 365 days (not the 14-day window the twin simulation uses).
    year_weather = get_trailing_year_summary(lat, lon)
    if year_weather is None:
        return jsonify({"error": "Could not fetch the last year of weather for the yield model. Try again shortly."}), 503

    predicted = predict_yield(district, crop, year_weather["avg_temp"], year_weather["total_rainfall"], year_weather["total_et0"])
    hist_avg = historical_avg_yield(district, crop)

    # How the forecast evolved: the model re-run on the 365 days of weather ending
    # at each of the last 12 month-ends (same crop/district; weather is the only thing that moves).
    prediction_history = []
    for w in year_weather["rolling"]:
        p = predict_yield(district, crop, w["avg_temp"], w["total_rainfall"], w["total_et0"])
        if p is not None:
            prediction_history.append({"month": w["month"], "date": w["date"], "predicted": round(p, 1)})

    if predicted is None:
        return jsonify({"error": "Model isn't trained yet — run train_model.py first."}), 503

    recommendation = generate_recommendation(twin_state, predicted, hist_avg)

    updated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    ngsi_id = entity_id_for(district, crop)
    fiware_up = upsert_twin_entity(ngsi_id, twin_state, predicted, updated_at)

    LAST_RESULT = {
        "district": district,
        "crop": crop,
        "area": area,
        "location_label": location_label,
        "used_exact_location": used_exact_location,
        "farm_lat": lat,
        "farm_lon": lon,
        "current_weather": current,
        "recent_weather": recent,
        "twin_state": twin_state,
        "twin_history": twin.history[-14:],
        "yield_trajectory": twin.yield_trajectory(predicted),
        "recommendation": recommendation,
        "historical_trend": historical_trend(district, crop),
        "monthly_weather": year_weather["monthly"],
        "prediction_history": prediction_history,
        "updated_at": updated_at,
        "fiware_entity_id": ngsi_id,
        "fiware_connected": fiware_up,
    }

    return jsonify(LAST_RESULT)


@app.route("/api/twin-state")
def api_twin_state():
    if LAST_RESULT is None:
        return jsonify({"ready": False})

    result = dict(LAST_RESULT, districts=DISTRICT_MAP)
    orion_state = get_twin_entity(LAST_RESULT["fiware_entity_id"])
    if orion_state:
        # Orion is the source of truth for the twin's state when it's reachable —
        # this is a real read from the context broker, not just echoing local memory.
        result["twin_state"] = {
            **LAST_RESULT["twin_state"],
            "soil_water_mm": orion_state["soil_water_mm"],
            "soil_water_fill_pct": orion_state["soil_water_fill_pct"],
            "consecutive_dry_days": orion_state["consecutive_dry_days"],
            "drought_risk": orion_state["drought_risk"],
            "heat_stress": orion_state["heat_stress"],
            "status": orion_state["status"],
        }
        result["fiware_connected"] = True
        result["fiware_source"] = "orion"
    else:
        result["fiware_connected"] = False
        result["fiware_source"] = "local"

    return jsonify({"ready": True, **result})


# ---------------------------------------------------------------------------
# District observed twin (satellite + live weather), alerts, model report
# ---------------------------------------------------------------------------

@app.route("/api/tn/districts")
def api_tn_districts():
    return jsonify({"districts": twin_observed.summary()})


@app.route("/api/tn/district/<name>")
def api_tn_district(name):
    key = name.upper()
    if key not in TN_DISTRICTS:
        return jsonify({"error": "unknown district"}), 404
    state = twin_observed.get_state(key)
    if state is None:
        return jsonify({"error": "no observed state yet - the first refresh has not completed", "district": key}), 404
    return jsonify(state)


@app.route("/api/tn/history/<name>")
def api_tn_history(name):
    key = name.upper()
    if key not in TN_DISTRICTS:
        return jsonify({"error": "unknown district"}), 404
    return jsonify({"district": key, "history": twin_observed.read_history(key, limit=int(request.args.get("limit", 60)))})


@app.route("/api/alerts")
def api_alerts():
    district = (request.args.get("district") or "").upper() or None
    return jsonify({"alerts": alert_log.recent_alerts(limit=int(request.args.get("limit", 50)), district=district)})


@app.route("/api/model-info")
def api_model_info():
    return jsonify(twin_observed.model_info())


@app.route("/api/tn/refresh", methods=["POST", "GET"])
def api_tn_refresh():
    # runs in the background; poll /api/tn/districts for progress
    threading.Thread(target=twin_observed.refresh_all, daemon=True).start()
    return jsonify({"started": True})


if os.environ.get("DISABLE_SCHEDULER") != "1":
    twin_observed.start_scheduler()


if __name__ == "__main__":
    app.run(debug=True, port=5000, use_reloader=False)
