"""
Reads the digital twin's simulated state and the yield forecast, and turns
them into concrete, farmer-readable advice — the prescriptive layer described
in the report's architecture.
"""

TARGET_SOIL_WATER_MM = 110.0  # what we try to top the soil back up to when irrigating


def generate_recommendation(twin_state, predicted_yield, historical_avg_yield):
    lines = []

    # irrigation advice
    if twin_state["drought_risk"]:
        deficit = round(TARGET_SOIL_WATER_MM - twin_state["soil_water_mm"], 1)
        lines.append(
            f"Irrigate soon — roughly {deficit} mm of water is needed to bring the "
            f"root zone back to a healthy level. Soil water has been low for "
            f"{twin_state['consecutive_dry_days']} consecutive dry days."
        )
    else:
        lines.append("No irrigation needed right now — soil water levels are adequate.")

    # heat stress advice
    if twin_state["heat_stress"]:
        lines.append(
            "Daytime temperatures are above the safe threshold for this crop. "
            "Consider irrigating in the early morning or evening to reduce heat stress, "
            "and avoid midday fertilizer application."
        )

    # yield outlook
    if historical_avg_yield:
        diff_pct = round(((predicted_yield - historical_avg_yield) / historical_avg_yield) * 100, 1)
        if diff_pct >= 5:
            lines.append(f"Yield outlook is {diff_pct}% above this region's historical average — favorable conditions.")
        elif diff_pct <= -5:
            lines.append(f"Yield outlook is {abs(diff_pct)}% below this region's historical average — current weather conditions may be limiting productivity.")
        else:
            lines.append("Yield outlook is roughly in line with this region's historical average.")

    return {
        "status": twin_state["status"],
        "advice": lines,
        "predicted_yield_kg_per_ha": round(predicted_yield, 1),
        "historical_avg_yield_kg_per_ha": round(historical_avg_yield, 1) if historical_avg_yield else None,
    }
