"""
The adaptive digital twin: a live, continuously-updated simulated representation
of one farm's soil-water and stress state. This is deliberately NOT a sensor
reading — it's a physically-grounded simulation (a simple soil water balance
model) driven entirely by real weather data, matching the project's
hardware-free design.

Water balance logic: each day, soil water = previous soil water + rainfall -
evapotranspiration (ET0), clamped to a root-zone capacity. This is a standard,
simplified version of the water balance approach used in real agronomy
(a simplified FAO-56 crop water balance).
"""

ROOT_ZONE_CAPACITY_MM = 150.0   # max plant-available water the soil can hold
DROUGHT_THRESHOLD_MM = 40.0     # below this, the crop is water-stressed
HEAT_STRESS_TEMP_C = 35.0       # above this daily max temp, heat stress risk rises


class DigitalTwin:
    """One instance per farm. Holds the live simulated state."""

    def __init__(self, farm_id, crop, initial_soil_water=90.0):
        self.farm_id = farm_id
        self.crop = crop
        self.soil_water_mm = initial_soil_water
        self.history = []  # list of {date, soil_water, temp_max, rainfall, et0}
        self.consecutive_dry_days = 0

    def update_state(self, daily_weather):
        """
        daily_weather: dict with keys date, temp_max, temp_min, precipitation, et0
        (this is exactly the shape returned by weather.get_recent_history()).
        Updates the twin's simulated soil water balance day by day.
        """
        for day in daily_weather:
            rainfall = day.get("precipitation") or 0
            et0 = day.get("et0") or 0
            self.soil_water_mm = max(0.0, min(ROOT_ZONE_CAPACITY_MM, self.soil_water_mm + rainfall - et0))

            if rainfall < 1.0:
                self.consecutive_dry_days += 1
            else:
                self.consecutive_dry_days = 0

            self.history.append({
                "date": day.get("date"),
                "soil_water_mm": round(self.soil_water_mm, 1),
                "temp_max": day.get("temp_max"),
                "rainfall": rainfall,
                "et0": et0,
            })

    def simulate(self):
        """Returns the twin's current simulated state and any stress flags."""
        latest_temp = self.history[-1]["temp_max"] if self.history else None
        drought_risk = self.soil_water_mm < DROUGHT_THRESHOLD_MM
        heat_stress = latest_temp is not None and latest_temp > HEAT_STRESS_TEMP_C

        fill_pct = round((self.soil_water_mm / ROOT_ZONE_CAPACITY_MM) * 100, 1)

        return {
            "farm_id": self.farm_id,
            "crop": self.crop,
            "soil_water_mm": round(self.soil_water_mm, 1),
            "soil_water_capacity_mm": ROOT_ZONE_CAPACITY_MM,
            "soil_water_fill_pct": fill_pct,
            "consecutive_dry_days": self.consecutive_dry_days,
            "drought_risk": drought_risk,
            "heat_stress": heat_stress,
            "status": self._status_label(drought_risk, heat_stress),
        }

    @staticmethod
    def _status_label(drought_risk, heat_stress):
        if drought_risk and heat_stress:
            return "Critical — drought and heat stress"
        if drought_risk:
            return "Water-stressed"
        if heat_stress:
            return "Heat-stressed"
        return "Healthy"

    def yield_trajectory(self, base_predicted_yield):
        """
        A day-by-day projected yield trajectory for the CURRENT season —
        not a fabricated monthly yield record (real yield is only measured
        once per harvest), but a transparent running adjustment: each day's
        projected yield is nudged down for drought/heat stress observed up
        to that point, and recovers on healthy days. This gives a genuine
        day-to-day changing chart instead of a single static number.
        """
        if not self.history:
            return []

        trajectory = []
        stress_days = 0
        for i, day in enumerate(self.history, start=1):
            is_stressed = day["soil_water_mm"] < DROUGHT_THRESHOLD_MM or \
                          (day["temp_max"] is not None and day["temp_max"] > HEAT_STRESS_TEMP_C)
            if is_stressed:
                stress_days += 1
            stress_fraction = stress_days / i
            # each fully-stressed day-fraction shaves up to 15% off the season's projected yield
            adjustment = 1 - (stress_fraction * 0.15)
            trajectory.append({
                "date": day["date"],
                "projected_yield_kg_per_ha": round(base_predicted_yield * adjustment, 1),
            })
        return trajectory
