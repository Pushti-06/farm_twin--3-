"""
Alert logic and alert log for the district twins.

evaluate_alert() is a pure function: it turns OBSERVED indicators (satellite NDVI anomaly, rainfall
vs normal, consecutive dry days, heat) and one SIMULATED flag (soil-water drought) into an alert
level plus the evidence behind it. Missing indicators are simply absent from the evidence - they are
never assumed normal or bad.

Rules (each indicator scores points; the level comes from the total and from corroboration):
  NDVI vs same-period climatology   z <= -2 or <= -20%: 3 | z <= -1.5 or <= -12%: 2 | z <= -1 or <= -7%: 1
  Rainfall vs normal (worse of the   ratio <= 0.40: 2 | ratio <= 0.60: 1      (only if the normal is >= 20 mm)
    14-day and 30-day windows)
  Consecutive dry days (< 1 mm)      >= 14 days: 1
  Heat (>= 35 C on 3 of last 5 days) 1
  Simulated soil-water drought flag  1   (labelled SIMULATED in the evidence)
Level: 0 none | 1-2 watch | 3-4 warning | >= 5 critical.
Corroboration: warning needs >= 2 indicators; critical needs NDVI stress (>= 2 pts) plus at least one
other indicator. Otherwise the level is capped one step lower.

Alerts describe what was observed and recommend verifying in the field. They never prescribe
irrigation or fertiliser from NDVI alone.
"""

import json
import os
import smtplib
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import requests

ALERT_LOG = os.environ.get("ALERT_LOG", "alerts.jsonl")
DEDUPE_HOURS = 24
LEVELS = ["none", "watch", "warning", "critical"]
_lock = threading.Lock()


def _ndvi_points(anom):
    if not anom:
        return 0
    z, pct = anom["z"], anom["pct"]
    if z <= -2 or pct <= -20:
        return 3
    if z <= -1.5 or pct <= -12:
        return 2
    if z <= -1 or pct <= -7:
        return 1
    return 0


def evaluate_alert(ndvi_anomaly=None, ndvi_date=None, ndvi_source=None, rain=None, dry_days=None,
                   heat_days_5=None, soil_drought=None, weather_date=None):
    """Returns {"level", "points", "evidence": [...], "message"}.

    ndvi_anomaly: dict(z, pct, clim_mean, clim_std, n, ndvi) or None
    rain: dict(actual_14, normal_14, actual_30, normal_30) (mm) or None
    """
    evidence = []

    pts = _ndvi_points(ndvi_anomaly)
    if ndvi_anomaly:
        evidence.append({
            "indicator": "NDVI below same-period normal" if pts else "NDVI vs same-period normal",
            "kind": "observed", "points": pts, "source": ndvi_source, "date": ndvi_date,
            "value": f"NDVI {ndvi_anomaly['ndvi']:.2f} vs normal {ndvi_anomaly['clim_mean']:.2f} "
                     f"({ndvi_anomaly['pct']:+.0f}%, z {ndvi_anomaly['z']:+.1f}, {ndvi_anomaly['n']} reference years)"})
    ndvi_pts = pts

    rain_pts = 0
    if rain:
        worst = None
        for win in (14, 30):
            a, n = rain.get(f"actual_{win}"), rain.get(f"normal_{win}")
            if a is None or n is None or n < 20:
                continue
            ratio = a / n
            if worst is None or ratio < worst[0]:
                worst = (ratio, win, a, n)
        if worst:
            ratio, win, a, n = worst
            rain_pts = 2 if ratio <= 0.40 else 1 if ratio <= 0.60 else 0
            evidence.append({"indicator": "Rainfall deficit" if rain_pts else "Rainfall vs normal", "kind": "observed",
                             "points": rain_pts, "source": "Open-Meteo / NASA POWER normals", "date": weather_date,
                             "value": f"{a:.0f} mm in last {win} days vs normal {n:.0f} mm ({ratio * 100:.0f}% of normal)"})

    dry_pts = 0
    if dry_days is not None:
        dry_pts = 1 if dry_days >= 14 else 0
        if dry_days >= 7 or dry_pts:
            evidence.append({"indicator": "Consecutive dry days", "kind": "observed", "points": dry_pts,
                             "source": "Open-Meteo", "date": weather_date, "value": f"{dry_days} days with < 1 mm rain"})

    heat_pts = 0
    if heat_days_5 is not None and heat_days_5 >= 3:
        heat_pts = 1
        evidence.append({"indicator": "Heat", "kind": "observed", "points": 1, "source": "Open-Meteo",
                         "date": weather_date, "value": f">= 35 C on {heat_days_5} of the last 5 days"})

    soil_pts = 0
    if soil_drought:
        soil_pts = 1
        evidence.append({"indicator": "Soil-water drought flag", "kind": "simulated", "points": 1,
                         "source": "soil-water balance model (not measured)", "date": weather_date,
                         "value": "simulated root-zone water below the stress threshold"})

    total = ndvi_pts + rain_pts + dry_pts + heat_pts + soil_pts
    level_i = 0 if total == 0 else 1 if total <= 2 else 2 if total <= 4 else 3
    # a simulated flag may support an alert but never raises one on its own
    if ndvi_pts + rain_pts + dry_pts + heat_pts == 0:
        level_i = 0
    indicators = sum(1 for p in (ndvi_pts, rain_pts, dry_pts, heat_pts, soil_pts) if p > 0)
    if level_i >= 2 and indicators < 2:
        level_i = 1
    if level_i == 3 and not (ndvi_pts >= 2 and indicators >= 2):
        level_i = 2
    level = LEVELS[level_i]

    if level == "none":
        msg = "No indicator is clearly outside its normal range."
    else:
        names = ", ".join(e["indicator"].lower() for e in evidence if e["points"])
        msg = (f"Observed: {names}. These are district-average indicators; "
               f"please verify conditions in the field before acting.")
    return {"level": level, "points": total, "evidence": evidence, "message": msg}


# ---------------------------------------------------------------------------
# Log, de-duplication, notification
# ---------------------------------------------------------------------------

def _signature(alert):
    return "|".join(sorted(e["indicator"] for e in alert["evidence"] if e["points"]))


def _read_log(path=None):
    path = path or ALERT_LOG
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def record_alert(district, crop, alert, freshness, now=None, path=None):
    """Appends the alert to alerts.jsonl unless the same (district, crop, level, indicators) was
    already logged in the last 24 h. Returns the record, or None if nothing was written."""
    if alert["level"] == "none":
        return None
    path = path or ALERT_LOG
    now = now or datetime.now(timezone.utc)
    sig = _signature(alert)
    with _lock:
        for r in reversed(_read_log(path)):
            if r["district"] == district and r.get("crop") == crop and r["level"] == alert["level"] and r["signature"] == sig:
                if now - datetime.fromisoformat(r["timestamp"]) < timedelta(hours=DEDUPE_HOURS):
                    return None
                break
        rec = {"timestamp": now.isoformat(timespec="seconds"), "district": district, "crop": crop,
               "level": alert["level"], "signature": sig, "message": alert["message"],
               "evidence": alert["evidence"], "freshness": freshness}
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    notify(rec)
    return rec


def recent_alerts(limit=50, district=None, path=None):
    rows = _read_log(path)
    if district:
        rows = [r for r in rows if r["district"] == district]
    return list(reversed(rows))[:limit]


def notify(rec):
    """Optional email / Telegram for warning and critical alerts. Configured only through env vars:
    TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and/or SMTP_HOST + ALERT_EMAIL_TO (+ SMTP_USER, SMTP_PASSWORD,
    SMTP_PORT, ALERT_EMAIL_FROM). Failures never affect the twin."""
    if rec["level"] not in ("warning", "critical"):
        return
    try:  # registered users (users.py); never affects the twin
        import users
        users.notify_subscribers(rec)
    except Exception:
        pass
    ev = "; ".join(f"{e['indicator']}: {e['value']}" for e in rec["evidence"] if e["points"])
    text = f"[{rec['level'].upper()}] {rec['district']} ({rec.get('crop') or 'all crops'}): {ev}. Verify in the field."
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat:
        try:
            requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": chat, "text": text}, timeout=10)
        except requests.exceptions.RequestException:
            pass
    host, to = os.environ.get("SMTP_HOST"), os.environ.get("ALERT_EMAIL_TO")
    if host and to:
        try:
            msg = EmailMessage()
            msg["Subject"] = f"Crop alert {rec['level']}: {rec['district']}"
            msg["From"] = os.environ.get("ALERT_EMAIL_FROM", os.environ.get("SMTP_USER", "twin@localhost"))
            msg["To"] = to
            msg.set_content(text)
            with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
                s.starttls()
                if os.environ.get("SMTP_USER"):
                    s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
                s.send_message(msg)
        except (OSError, smtplib.SMTPException):
            pass
