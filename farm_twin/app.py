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
    python process_data.py              # once, aggregates the real dataset
    python build_training_dataset.py    # once, merges in real historical weather (needs internet)
    python train_model.py               # once, trains the yield model
    python app.py
"""

import csv
import pickle
from collections import defaultdict
from datetime import datetime

from flask import Flask, render_template, request, jsonify

from state_coordinates import STATE_COORDINATES
from weather import get_current_weather, get_recent_history, search_location
from digital_twin import DigitalTwin
from recommendation import generate_recommendation
from fiware_client import is_fiware_reachable, upsert_twin_entity, get_twin_entity
from fiware_config import entity_id_for

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Load real data + trained model once at startup
# ---------------------------------------------------------------------------

with open("data/crop_yield_by_state_year.csv") as f:
    YIELD_ROWS = list(csv.DictReader(f))

STATES = sorted(STATE_COORDINATES.keys())
CROPS_BY_STATE = defaultdict(set)
for r in YIELD_ROWS:
    CROPS_BY_STATE[r["State"]].add(r["Crop"])
CROPS_BY_STATE = {s: sorted(c) for s, c in CROPS_BY_STATE.items()}

try:
    with open("model/yield_model.pkl", "rb") as f:
        MODEL_BUNDLE = pickle.load(f)
except FileNotFoundError:
    MODEL_BUNDLE = None  # app still runs; dashboard will show a setup message

# in-memory store for the current demo farm (single-farm prototype)
FARM_TWINS = {}       # farm_id -> DigitalTwin instance
LAST_RESULT = None    # most recent full prediction+twin+recommendation result


def historical_avg_yield(state, crop):
    matches = [float(r["Yield_kg_per_ha"]) for r in YIELD_ROWS if r["State"] == state and r["Crop"] == crop]
    return sum(matches) / len(matches) if matches else None


def historical_trend(state, crop):
    matches = sorted(
        [(int(r["Year"]), float(r["Yield_kg_per_ha"])) for r in YIELD_ROWS if r["State"] == state and r["Crop"] == crop]
    )
    return {"years": [m[0] for m in matches], "yields": [m[1] for m in matches]}


def predict_yield(state, crop, area, avg_temp, total_rainfall, total_et0):
    if MODEL_BUNDLE is None:
        return None
    b = MODEL_BUNDLE
    try:
        crop_enc = b["crop_encoder"].transform([crop])[0]
        state_enc = b["state_encoder"].transform([state])[0]
    except ValueError:
        return None  # crop/state wasn't in training data
    features = [[crop_enc, state_enc, datetime.now().year, area, avg_temp, total_rainfall, total_et0]]
    return float(b["model"].predict(features)[0])


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def dashboard():
    return render_template("dashboard.html", states=STATES, crops_by_state=CROPS_BY_STATE, model_ready=MODEL_BUNDLE is not None)


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
    state = body.get("state")
    crop = body.get("crop")
    area = float(body.get("area", 1.0))

    # Exact farm location (geocoded village/town) takes priority over the
    # state-capital coordinate fallback — this is what makes weather genuinely
    # local to the farmer's actual field, not a generic state-wide proxy.
    farm_lat = body.get("farm_lat")
    farm_lon = body.get("farm_lon")
    farm_location_name = body.get("farm_location_name")

    if farm_lat is not None and farm_lon is not None:
        lat, lon = float(farm_lat), float(farm_lon)
        location_label = farm_location_name or f"{lat:.4f}, {lon:.4f}"
        used_exact_location = True
    elif state in STATE_COORDINATES:
        lat, lon = STATE_COORDINATES[state]
        location_label = f"{state} (state-level approximation)"
        used_exact_location = False
    else:
        return jsonify({"error": "Unknown state or farm location"}), 400

    current = get_current_weather(lat, lon)
    recent = get_recent_history(lat, lon, days=14)

    if current is None or not recent:
        return jsonify({"error": "Could not reach the weather service. Check your internet connection and try again."}), 503

    # update (or create) this farm's digital twin from real recent weather
    farm_id = f"{state}:{crop}:{location_label}"
    twin = FARM_TWINS.get(farm_id) or DigitalTwin(farm_id, crop)
    twin.update_state(recent)
    FARM_TWINS[farm_id] = twin
    twin_state = twin.simulate()

    avg_temp = sum(d["temp_max"] for d in recent if d["temp_max"] is not None) / len(recent)
    total_rainfall = sum(d["precipitation"] or 0 for d in recent)
    total_et0 = sum(d["et0"] or 0 for d in recent)

    predicted = predict_yield(state, crop, area, avg_temp, total_rainfall, total_et0)
    hist_avg = historical_avg_yield(state, crop)

    if predicted is None:
        return jsonify({"error": "Model isn't trained yet — run train_model.py first."}), 503

    recommendation = generate_recommendation(twin_state, predicted, hist_avg)

    updated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    ngsi_id = entity_id_for(state, crop)
    fiware_up = upsert_twin_entity(ngsi_id, twin_state, predicted, updated_at)

    LAST_RESULT = {
        "state": state,
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
        "historical_trend": historical_trend(state, crop),
        "updated_at": updated_at,
        "fiware_entity_id": ngsi_id,
        "fiware_connected": fiware_up,
    }

    return jsonify(LAST_RESULT)


@app.route("/api/twin-state")
def api_twin_state():
    if LAST_RESULT is None:
        return jsonify({"ready": False})

    result = dict(LAST_RESULT)
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


if __name__ == "__main__":
    app.run(debug=True, port=5000, use_reloader=False)
