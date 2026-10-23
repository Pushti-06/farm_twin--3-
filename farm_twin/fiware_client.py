"""
Thin client for pushing the digital twin's state into Orion Context Broker
and reading it back. Every function fails soft — if Orion isn't running,
functions return None/False instead of raising, so the app falls back to
its local computation and never crashes because FIWARE is offline.
"""

import requests

from fiware_config import ORION_URL, HEADERS, WRITE_HEADERS, ENTITY_TYPE, REQUEST_TIMEOUT


def is_fiware_reachable():
    try:
        r = requests.get(f"{ORION_URL}/version", timeout=REQUEST_TIMEOUT)
        return r.status_code == 200
    except requests.exceptions.RequestException:
        return False


def _attr(value, attr_type):
    return {"value": value, "type": attr_type}


def upsert_twin_entity(entity_id, twin_state, predicted_yield, updated_at):
    """Creates or fully replaces the FarmTwin entity in Orion. Returns True/False."""
    body = {
        "id": entity_id,
        "type": ENTITY_TYPE,
        "soilWaterMm": _attr(twin_state["soil_water_mm"], "Number"),
        "soilWaterFillPct": _attr(twin_state["soil_water_fill_pct"], "Number"),
        "consecutiveDryDays": _attr(twin_state["consecutive_dry_days"], "Number"),
        "droughtRisk": _attr(twin_state["drought_risk"], "Boolean"),
        "heatStress": _attr(twin_state["heat_stress"], "Boolean"),
        "status": _attr(twin_state["status"], "Text"),
        "predictedYield": _attr(round(predicted_yield, 1), "Number"),
        "updatedAt": _attr(updated_at, "Text"),
    }
    try:
        r = requests.post(
            f"{ORION_URL}/v2/entities",
            params={"options": "upsert"},
            json=body, headers=WRITE_HEADERS, timeout=REQUEST_TIMEOUT,
        )
        return r.status_code in (201, 204)
    except requests.exceptions.RequestException:
        return False


def get_twin_entity(entity_id):
    """Reads the current FarmTwin entity back from Orion. Returns a dict or None."""
    try:
        r = requests.get(f"{ORION_URL}/v2/entities/{entity_id}", headers=HEADERS, timeout=REQUEST_TIMEOUT)
        if r.status_code != 200:
            return None
        data = r.json()
        return {
            "soil_water_mm": data["soilWaterMm"]["value"],
            "soil_water_fill_pct": data["soilWaterFillPct"]["value"],
            "consecutive_dry_days": data["consecutiveDryDays"]["value"],
            "drought_risk": data["droughtRisk"]["value"],
            "heat_stress": data["heatStress"]["value"],
            "status": data["status"]["value"],
            "predicted_yield": data["predictedYield"]["value"],
            "updated_at": data["updatedAt"]["value"],
        }
    except (requests.exceptions.RequestException, KeyError):
        return None


def _num(v):
    return _attr(None if v is None else round(float(v), 4), "Number")


def upsert_district_entity(entity_id, state):
    """Creates/updates the per-district observed twin in Orion (type DistrictTwin).
    Missing observations are sent as null, never as a made-up number. Returns True/False."""
    from fiware_config import DISTRICT_ENTITY_TYPE
    sat = (state.get("observed") or {}).get("satellite") or {}
    s2 = sat.get("sentinel2") or {}
    modis = sat.get("modis") or {}
    pred = state.get("predicted") or {}
    sim = state.get("simulated") or {}
    alert = state.get("alert") or {}
    ndvi_src = "sentinel2" if s2.get("ndvi") is not None else ("modis" if modis.get("ndvi") is not None else None)
    pick = (lambda k: s2.get(k) if ndvi_src == "sentinel2" else modis.get(k))
    body = {
        "id": entity_id, "type": DISTRICT_ENTITY_TYPE,
        "ndvi": _num(pick("ndvi")), "evi": _num(pick("evi")), "lswi": _num(pick("lswi")),
        "satelliteSource": _attr(ndvi_src, "Text"),
        "satelliteDate": _attr(s2.get("last_acquisition") if ndvi_src == "sentinel2" else modis.get("date"), "Text"),
        "ndviAnomalyZ": _num((sat.get("anomaly") or {}).get("z")),
        "predictedYield": _num(pred.get("yield_kg_ha")),
        "predictedCrop": _attr(pred.get("crop"), "Text"),
        "modelVersion": _attr(pred.get("model_version"), "Text"),
        "modelTypicalErrorPct": _num(pred.get("typical_error_pct")),
        "modelFittedThrough": _attr(pred.get("fitted_through"), "Number"),
        "soilWaterMm": _num(sim.get("soil_water_mm")),
        "alertLevel": _attr(alert.get("level", "none"), "Text"),
        "cropSeason": _attr((state.get("crop_season") or {}).get("season"), "Text"),
        "agriYear": _attr((state.get("crop_season") or {}).get("agri_year"), "Number"),
        "updatedAt": _attr(state.get("updated_at"), "Text"),
    }
    try:
        r = requests.post(f"{ORION_URL}/v2/entities", params={"options": "upsert"},
                          json=body, headers=WRITE_HEADERS, timeout=REQUEST_TIMEOUT)
        return r.status_code in (201, 204)
    except requests.exceptions.RequestException:
        return False
