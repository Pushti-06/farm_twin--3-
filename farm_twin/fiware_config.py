"""
FIWARE configuration for the Adaptive Digital Twin.

Entity model
------------
Type:  FarmTwin
ID:    urn:ngsi-ld:FarmTwin:<State>:<Crop>   (spaces replaced with underscores)
Attrs: soilWaterMm, soilWaterFillPct, consecutiveDryDays, droughtRisk,
       heatStress, status, predictedYield, updatedAt

This entity IS the digital twin in the FIWARE sense: a live, queryable
representation of the farm's current simulated state, held in Orion.
The simulation logic itself still runs in Python (digital_twin.py) —
Orion's job is just to be the authoritative, queryable store of the
twin's current state, the same role it plays in any FIWARE deployment.
"""

ORION_URL = "http://localhost:1026"
FIWARE_SERVICE = "farmtwin"
FIWARE_SERVICEPATH = "/twin"
ENTITY_TYPE = "FarmTwin"

HEADERS = {
    "fiware-service": FIWARE_SERVICE,
    "fiware-servicepath": FIWARE_SERVICEPATH,
}

# Orion rejects GET/DELETE requests that carry a Content-Type header at all —
# so writes (POST/PATCH) need this extra header, reads (GET) must NOT have it.
WRITE_HEADERS = {
    **HEADERS,
    "Content-Type": "application/json",
}

REQUEST_TIMEOUT = 1.5  # short timeout so the app falls back fast if Orion is down


def entity_id_for(state, crop):
    safe_state = state.replace(" ", "_")
    return f"urn:ngsi-ld:FarmTwin:{safe_state}:{crop}"
