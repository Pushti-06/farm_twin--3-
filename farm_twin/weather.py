"""
Wraps the Open-Meteo API (https://open-meteo.com) — free, no API key required.

Two endpoints are used:
- Forecast/current API: live current weather, used by the dashboard and the
  digital twin's live state updates.
- Historical Archive API: past daily weather, used once (by
  build_training_dataset.py) to attach real historical weather to each
  state-year row in the crop yield dataset, so the yield-prediction model
  can actually learn the weather -> yield relationship.

Both endpoints return the FAO-56 reference evapotranspiration (et0_fao_evapotranspiration)
directly, so we don't need to hand-implement the Penman-Monteith formula ourselves —
Open-Meteo computes it from temperature, humidity, wind, and solar radiation internally.
"""

import requests

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
TIMEOUT = 10


def search_location(query):
    """
    Looks up a place name (village, town, city) and returns real matching
    locations with their exact coordinates — this is how a farmer's actual
    farm location (not just a state capital) gets used for every weather call.
    Free, no API key, same provider as the rest of this file.
    """
    try:
        r = requests.get(GEOCODE_URL, params={
            "name": query, "count": 6, "language": "en", "format": "json",
        }, timeout=TIMEOUT)
        r.raise_for_status()
        results = r.json().get("results", [])
        return [
            {
                "name": item.get("name"),
                "admin1": item.get("admin1"),   # state/region
                "country": item.get("country"),
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
            }
            for item in results
        ]
    except requests.exceptions.RequestException:
        return []


def get_current_weather(lat, lon):
    """Live current conditions + today's ET0. Returns None on failure."""
    try:
        r = requests.get(FORECAST_URL, params={
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code",
            "daily": "et0_fao_evapotranspiration,precipitation_sum,temperature_2m_max,temperature_2m_min",
            "forecast_days": 1,
            "timezone": "auto",
        }, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        current = data.get("current", {})
        daily = data.get("daily", {})
        return {
            "temperature": current.get("temperature_2m"),
            "humidity": current.get("relative_humidity_2m"),
            "precipitation": current.get("precipitation"),
            "wind_speed": current.get("wind_speed_10m"),
            "weather_code": current.get("weather_code"),
            "et0": (daily.get("et0_fao_evapotranspiration") or [None])[0],
            "temp_max": (daily.get("temperature_2m_max") or [None])[0],
            "temp_min": (daily.get("temperature_2m_min") or [None])[0],
        }
    except (requests.exceptions.RequestException, KeyError, IndexError):
        return None


def get_recent_history(lat, lon, days=14):
    """Last N days of daily weather, for charting recent trends on the dashboard."""
    try:
        r = requests.get(FORECAST_URL, params={
            "latitude": lat, "longitude": lon,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
            "past_days": days,
            "forecast_days": 1,
            "timezone": "auto",
        }, timeout=TIMEOUT)
        r.raise_for_status()
        daily = r.json().get("daily", {})
        dates = daily.get("time", [])
        return [
            {
                "date": dates[i],
                "temp_max": daily["temperature_2m_max"][i],
                "temp_min": daily["temperature_2m_min"][i],
                "precipitation": daily["precipitation_sum"][i],
                "et0": daily["et0_fao_evapotranspiration"][i],
            }
            for i in range(len(dates))
        ]
    except (requests.exceptions.RequestException, KeyError, IndexError):
        return []


def get_historical_year_summary(lat, lon, year):
    """
    Real historical weather for one full year, aggregated into training features:
    average temperature, total rainfall, and total reference evapotranspiration.
    Used only when building the training dataset (build_training_dataset.py).
    """
    try:
        r = requests.get(ARCHIVE_URL, params={
            "latitude": lat, "longitude": lon,
            "start_date": f"{year}-01-01", "end_date": f"{year}-12-31",
            "daily": "temperature_2m_mean,precipitation_sum,et0_fao_evapotranspiration",
            "timezone": "auto",
        }, timeout=30)
        r.raise_for_status()
        daily = r.json().get("daily", {})
        temps = [t for t in daily.get("temperature_2m_mean", []) if t is not None]
        rain = [p for p in daily.get("precipitation_sum", []) if p is not None]
        et0 = [e for e in daily.get("et0_fao_evapotranspiration", []) if e is not None]
        if not temps:
            return None
        return {
            "avg_temp": round(sum(temps) / len(temps), 2),
            "total_rainfall": round(sum(rain), 1),
            "total_et0": round(sum(et0), 1) if et0 else None,
        }
    except (requests.exceptions.RequestException, KeyError):
        return None
