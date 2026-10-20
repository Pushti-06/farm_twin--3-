"""
Wraps the Open-Meteo API (https://open-meteo.com) — free, no API key required.

Two endpoints are used:
- Forecast/current API: live current weather, used by the dashboard and the
  digital twin's live state updates.
- NASA POWER daily API (https://power.larc.nasa.gov): historical daily weather
  (also free, no key, no hourly cap), used by build_training_dataset.py to attach
  real historical weather to each district-year row in the crop yield dataset
  (so the yield-prediction model can learn the weather -> yield relationship),
  and at prediction time for the trailing 365 days.

Open-Meteo returns the FAO-56 reference evapotranspiration (ET0) directly. NASA POWER
doesn't, so for the historical series ET0 is estimated from daily temperature with the
Hargreaves equation (FAO-56 radiation term from latitude and day of year).
"""

import math
import time
from datetime import date, timedelta

import requests

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
TIMEOUT = 10


def search_location(query):
    """
    Looks up a place name (village, town, city) and returns real matching
    locations with their exact coordinates — this is how a farmer's actual
    farm location (not just a state capital) gets used for every weather call.
    Free, no API key, same provider as the rest of this file. Results are
    limited to Tamil Nadu, the only region this twin covers.
    """
    try:
        r = requests.get(GEOCODE_URL, params={
            "name": query, "count": 50, "language": "en", "format": "json", "countryCode": "IN",
        }, timeout=TIMEOUT)
        r.raise_for_status()
        results = [i for i in r.json().get("results", []) if i.get("admin1") == "Tamil Nadu"][:6]
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


def _summarize(dates, temps_all, rain_all, et0_all):
    """Aggregates daily series into per-year training features."""
    buckets = {}
    for d, t, p, e in zip(dates, temps_all, rain_all, et0_all):
        b = buckets.setdefault(d[:4], {"t": [], "p": [], "e": []})
        if t is not None: b["t"].append(t)
        if p is not None: b["p"].append(p)
        if e is not None: b["e"].append(e)
    return {
        int(y): {
            "avg_temp": round(sum(b["t"]) / len(b["t"]), 2),
            "total_rainfall": round(sum(b["p"]), 1),
            "total_et0": round(sum(b["e"]), 1) if b["e"] else None,
        }
        for y, b in buckets.items() if b["t"]
    }


def _extraterrestrial_radiation(lat, day_of_year):
    """Daily extraterrestrial radiation Ra in mm/day of evaporation equivalent (FAO-56 eq. 21)."""
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * day_of_year / 365)
    decl = 0.409 * math.sin(2 * math.pi * day_of_year / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(decl))))
    ra_mj = (24 * 60 / math.pi) * 0.0820 * dr * (
        ws * math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.sin(ws))
    return ra_mj * 0.408


def _hargreaves_et0(lat, day, tmean, tmax, tmin):
    ra = _extraterrestrial_radiation(lat, day.timetuple().tm_yday)
    return max(0.0, 0.0023 * (tmean + 17.8) * math.sqrt(max(0.0, tmax - tmin)) * ra)


MAX_PLAUSIBLE_ANNUAL_RAIN_MM = 6000   # far above any Tamil Nadu district's real annual rainfall


def _fetch_history_once(lat, lon, start, end):
    r = requests.get(POWER_URL, params={
        "parameters": "T2M,T2M_MAX,T2M_MIN,PRECTOTCORR", "community": "AG",
        "latitude": lat, "longitude": lon,
        "start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"), "format": "JSON",
    }, timeout=120)
    r.raise_for_status()
    p = r.json()["properties"]["parameter"]
    dates, temps, rain, et0 = [], [], [], []
    for key in sorted(p["T2M"]):
        day = date(int(key[:4]), int(key[4:6]), int(key[6:]))
        tm, tx, tn, pr = p["T2M"][key], p["T2M_MAX"][key], p["T2M_MIN"][key], p["PRECTOTCORR"][key]
        ok = tm != -999 and tx != -999 and tn != -999
        dates.append(day.isoformat())
        temps.append(tm if tm != -999 else None)
        rain.append(pr if pr != -999 else None)
        et0.append(_hargreaves_et0(lat, day, tm, tx, tn) if ok else None)
    return dates, temps, rain, et0


def _rain_is_plausible(dates, rain):
    totals = {}
    for d, p in zip(dates, rain):
        if p is not None:
            totals[d[:4]] = totals.get(d[:4], 0.0) + p
    # judge full years only; a partial year's total is naturally smaller anyway
    return all(t <= MAX_PLAUSIBLE_ANNUAL_RAIN_MM for t in totals.values())


POWER_RAIN_GLITCH_FACTOR = 24   # observed: glitched responses report rainfall exactly 24x too high


def _fetch_history(lat, lon, start, end, attempts=3):
    """Daily series from NASA POWER between two dates (inclusive).
    Returns (iso_dates, temp_mean, rainfall_mm, et0_mm); missing values are None.

    POWER intermittently returns a whole response with rainfall inflated by
    exactly 24x (the same query is fine on the next call, and the other variables
    are unaffected). Implausible responses are retried; if it keeps happening the
    24x is divided back out, and the result is only used if it then passes the same
    plausibility check. Raises ValueError otherwise."""
    result = None
    for attempt in range(attempts):
        result = _fetch_history_once(lat, lon, start, end)
        if _rain_is_plausible(result[0], result[2]):
            return result
        time.sleep(1.5)
    dates, temps, rain, et0 = result
    fixed = [None if p is None else p / POWER_RAIN_GLITCH_FACTOR for p in rain]
    if _rain_is_plausible(dates, fixed):
        return dates, temps, fixed, et0
    raise ValueError("NASA POWER returned implausible rainfall values")


def get_historical_year_summaries(lat, lon, start_year, end_year):
    """
    Real historical weather for every year in [start_year, end_year] in ONE API
    call, aggregated per year into training features: average temperature, total
    rainfall, and total reference evapotranspiration. Returns {year: summary}
    ({} on failure). Used only when building the training dataset.
    """
    try:
        return _summarize(*_fetch_history(lat, lon, date(start_year, 1, 1), date(end_year, 12, 31)))
    except (requests.exceptions.RequestException, KeyError, ValueError):
        return {}


def _monthly_breakdown(dates, temps, rain, et0):
    """Per-calendar-month averages/totals for charting: [{month: 'YYYY-MM', ...}], oldest first."""
    months = {}
    for d, t, p, e in zip(dates, temps, rain, et0):
        m = months.setdefault(d[:7], {"t": [], "p": [], "e": []})
        if t is not None: m["t"].append(t)
        if p is not None: m["p"].append(p)
        if e is not None: m["e"].append(e)
    return [
        {"month": k,
         "avg_temp": round(sum(v["t"]) / len(v["t"]), 1),
         "rainfall": round(sum(v["p"]), 1),
         "et0": round(sum(v["e"]), 1)}
        for k, v in sorted(months.items()) if v["t"]
    ]


def _window_features(temps, rain, et0):
    """The model's three weather features over one window of daily values (None = missing)."""
    t = [x for x in temps if x is not None]
    if not t:
        return None
    return {
        "avg_temp": round(sum(t) / len(t), 2),
        "total_rainfall": round(sum(x for x in rain if x is not None), 1),
        "total_et0": round(sum(x for x in et0 if x is not None), 1),
    }


def get_trailing_year_summary(lat, lon):
    """
    The model's weather features over the last 365 days (ending a week ago, since
    NASA POWER lags real time by a few days) - the same kind of input it was
    trained on. Also returns:
      monthly: per-month weather for the last 12 months (for charting)
      rolling: the same 365-day features as they stood at the end of each of the
               last 12 months, so the app can show how the forecast evolved
    One API call covers the extra year of history the rolling windows need.
    Returns None on failure.
    """
    end = date.today() - timedelta(days=7)
    start = end - timedelta(days=2 * 365 - 1)
    try:
        dates, temps, rain, et0 = _fetch_history(lat, lon, start, end)
    except (requests.exceptions.RequestException, KeyError, ValueError):
        return None
    if len(dates) < 2 * 365 - 5:
        return None

    n = len(dates)
    latest = _window_features(temps[n - 365:], rain[n - 365:], et0[n - 365:])
    if latest is None:
        return None

    # end-of-month index for each of the last 12 months (the final one is the latest day)
    last_idx = {}
    for i, d in enumerate(dates):
        last_idx[d[:7]] = i
    month_ends = sorted(last_idx.items())[-12:]
    rolling = []
    for month, i in month_ends:
        if i < 364:
            continue
        f = _window_features(temps[i - 364:i + 1], rain[i - 364:i + 1], et0[i - 364:i + 1])
        if f:
            rolling.append({"month": month, "date": dates[i], **f})

    return {
        **latest,
        "monthly": _monthly_breakdown(dates[n - 365:], temps[n - 365:], rain[n - 365:], et0[n - 365:]),
        "rolling": rolling,
    }
