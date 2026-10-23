"""Alert logic: small hand-made indicator sets. Dedup + log tested against a temp file."""
import json
from datetime import datetime, timedelta, timezone

import alerts as A


def an(z, pct, ndvi=0.4):
    return {"z": z, "pct": pct, "clim_mean": 0.55, "clim_std": 0.05, "n": 20, "ndvi": ndvi}


def test_all_normal_is_none():
    r = A.evaluate_alert(ndvi_anomaly=an(0.2, 2), rain={"actual_14": 50, "normal_14": 50, "actual_30": 100, "normal_30": 100},
                         dry_days=1, heat_days_5=0, soil_drought=False)
    assert r["level"] == "none"


def test_ndvi_alone_never_exceeds_watch():
    r = A.evaluate_alert(ndvi_anomaly=an(-3, -30))
    assert r["level"] == "watch"                      # 3 points but a single indicator -> capped
    assert "irrigat" not in r["message"].lower() and "fertili" not in r["message"].lower()
    assert "verify" in r["message"].lower()


def test_corroborated_stress_is_critical_and_marks_simulated_evidence():
    rain = {"actual_14": 5, "normal_14": 60, "actual_30": 20, "normal_30": 120}
    r = A.evaluate_alert(ndvi_anomaly=an(-2.5, -25), rain=rain, dry_days=15, heat_days_5=4, soil_drought=True)
    assert r["level"] == "critical"
    kinds = {e["indicator"]: e["kind"] for e in r["evidence"]}
    assert kinds["Soil-water drought flag"] == "simulated"


def test_critical_requires_ndvi_support():
    rain = {"actual_14": 1, "normal_14": 60, "actual_30": 5, "normal_30": 120}
    r = A.evaluate_alert(rain=rain, dry_days=20, heat_days_5=5, soil_drought=True)
    assert r["points"] >= 5 and r["level"] == "warning"


def test_rain_ignored_when_normal_is_tiny():
    r = A.evaluate_alert(rain={"actual_14": 0, "normal_14": 3, "actual_30": 0, "normal_30": 8})
    assert r["level"] == "none" and not r["evidence"]


def test_missing_inputs_do_not_create_alerts():
    r = A.evaluate_alert()
    assert r["level"] == "none" and r["evidence"] == []


def _alert():
    return A.evaluate_alert(ndvi_anomaly=an(-2.5, -25), dry_days=15, heat_days_5=4)


def test_dedupe_within_24h_but_not_after(tmp_path):
    p = str(tmp_path / "alerts.jsonl")
    t0 = datetime(2024, 8, 1, 6, tzinfo=timezone.utc)
    a = _alert()
    assert A.record_alert("SALEM", "RICE", a, {}, now=t0, path=p) is not None
    assert A.record_alert("SALEM", "RICE", a, {}, now=t0 + timedelta(hours=23), path=p) is None
    assert A.record_alert("SALEM", "RICE", a, {}, now=t0 + timedelta(hours=25), path=p) is not None
    assert A.record_alert("ERODE", "RICE", a, {}, now=t0 + timedelta(hours=1), path=p) is not None   # other district
    assert len(A.recent_alerts(path=p)) == 3


def test_none_level_not_logged_and_record_has_required_fields(tmp_path):
    p = str(tmp_path / "alerts.jsonl")
    assert A.record_alert("SALEM", "RICE", A.evaluate_alert(), {}, path=p) is None
    rec = A.record_alert("SALEM", "RICE", _alert(), {"satellite": {"age_days": 3}}, path=p)
    for k in ("timestamp", "district", "crop", "level", "evidence", "freshness"):
        assert k in rec
    assert json.loads(open(p).readline())["district"] == "SALEM"


def test_simulated_flag_alone_never_raises_an_alert():
    r = A.evaluate_alert(soil_drought=True)
    assert r["level"] == "none"
    r2 = A.evaluate_alert(ndvi_anomaly=an(-1.2, -8), soil_drought=True)    # observed + simulated together
    assert r2["level"] == "watch"
