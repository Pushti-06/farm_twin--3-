"""
Trains and honestly evaluates the Tamil Nadu yield model on CSV history + weather + satellite.

    python train_tn_model.py

Split (time based, never random): train <= 2014, validation 2015-16, test 2017-19.
Models:    RandomForest (baseline) and HistGradientBoosting, on log(yield).
Ablations: csv_only  |  csv_weather  |  csv_weather_satellite
Baselines: last-year yield, district-crop historical average (computed only from earlier years).
All numbers are on the SAME test rows (those that have a last-year yield), so models and baselines
are directly comparable. The deployed configuration is chosen on the VALIDATION years, never on test.

Produces
  model/tn_model_report.json       full metrics + plain-language interpretation
  model/tn_test_predictions.csv    predicted vs actual for every test row (all models + baselines)
  model/tn_model.pkl               deployed model (refit on train+validation years)
"""

import json
import os
import pickle
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.preprocessing import OrdinalEncoder

from satellite_aggregate import source_coverage
from tn_features import (CATEGORICAL, FEATURE_SETS, SAT_FEATURES, SATELLITE_CSV, SAT_SEASON, TEST_YEARS,
                         TRAIN_END, VAL_YEARS, add_satellite_features, build_features, load_satellite,
                         satellite_climatology, split, add_history_features, load_training)

REPORT = "model/tn_model_report.json"
PREDICTIONS = "model/tn_test_predictions.csv"
BUNDLE = "model/tn_model.pkl"
MODEL_VERSION = "tn-v2"


def make_models():
    return {
        "RandomForest": RandomForestRegressor(n_estimators=300, min_samples_leaf=2, n_jobs=-1, random_state=42),
        "HistGradientBoosting": HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, random_state=42),
    }


def metrics(actual, predicted):
    """actual/predicted in kg/ha. Log-space R2/RMSE (what the model optimises) and kg/ha MAE/RMSE/MAPE/R2."""
    a, p = np.asarray(actual, float), np.asarray(predicted, float)
    la, lp = np.log(a), np.log(np.clip(p, 1e-6, None))

    def r2(y, yh):
        ss = np.sum((y - y.mean()) ** 2)
        return float(1 - np.sum((y - yh) ** 2) / ss) if ss > 0 else None
    return {
        "n": int(len(a)),
        "mae_kg_ha": float(np.mean(np.abs(a - p))),
        "rmse_kg_ha": float(np.sqrt(np.mean((a - p) ** 2))),
        "mape_pct": float(np.mean(np.abs(a - p) / a) * 100),
        "r2_kg_ha": r2(a, p),
        "rmse_log": float(np.sqrt(np.mean((la - lp) ** 2))),
        "r2_log": r2(la, lp),
    }


def encode(df, cols, enc=None):
    X = df[cols].copy()
    cats = [c for c in CATEGORICAL if c in cols]
    if enc is None:
        enc = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1).fit(X[cats])
    X[cats] = enc.transform(X[cats])
    return X.astype(float), enc


def fit_predict(model, cols, train, test):
    Xtr, enc = encode(train, cols)
    model.fit(Xtr, np.log(train["yield"]))
    Xte, _ = encode(test, cols, enc)
    return np.exp(model.predict(Xte)), enc


def evaluate(train, test, feature_sets):
    """Returns ({config: metrics}, DataFrame of test predictions) on test rows that have a last-year yield."""
    common = test[test["yield_lag1"].notna()].copy()
    results, preds = {}, common[["crop", "district", "year", "yield"]].rename(columns={"yield": "actual"}).copy()
    if common.empty:
        return results, preds
    results["baseline_last_year"] = metrics(common["yield"], common["yield_lag1"])
    preds["pred_baseline_last_year"] = common["yield_lag1"].values
    hm = common["hist_mean"].fillna(common["yield_lag1"])
    results["baseline_district_crop_mean"] = metrics(common["yield"], hm)
    preds["pred_baseline_district_crop_mean"] = hm.values

    for fs_name, cols in feature_sets.items():
        for name, model in make_models().items():
            p, _ = fit_predict(model, cols, train, common)
            key = f"{name}/{fs_name}"
            results[key] = metrics(common["yield"], p)
            preds[f"pred_{key}"] = p
    return results, preds


def interpret(results, sat_coverage_test):
    lines = []
    naive = {k: v for k, v in results.items() if k.startswith("baseline")}
    if not naive:
        return ["No test rows with a last-year yield - cannot compare."]
    best_naive = min(naive, key=lambda k: naive[k]["rmse_log"])
    models = {k: v for k, v in results.items() if not k.startswith("baseline")}
    best_model = min(models, key=lambda k: models[k]["rmse_log"])
    lines.append(f"Best naive baseline on test: {best_naive} (log-RMSE {naive[best_naive]['rmse_log']:.3f}).")
    lines.append(f"Best model on test: {best_model} (log-RMSE {models[best_model]['rmse_log']:.3f}).")
    if models[best_model]["rmse_log"] >= naive[best_naive]["rmse_log"]:
        lines.append("No model beat the best naive baseline on the test years: the extra features did not add "
                     "predictive value over simply carrying yesterday's information forward.")
    for algo in ("RandomForest", "HistGradientBoosting"):
        w, s = results.get(f"{algo}/csv_weather"), results.get(f"{algo}/csv_weather_satellite")
        if w and s:
            d = w["rmse_log"] - s["rmse_log"]
            if sat_coverage_test < 0.5:
                lines.append(f"{algo}: only {sat_coverage_test:.0%} of test rows have satellite features, so this "
                             f"comparison is weak.")
            lines.append(f"{algo}: adding satellite features changed log-RMSE by {-d:+.3f} "
                         f"({'improved' if d > 0 else 'did NOT improve'}) versus CSV+weather.")
    lines.append("R2 should be read cautiously: yields differ by crop by orders of magnitude, so a high R2 on "
                 "log yield mostly reflects crop identity; judge improvement against the naive baselines.")
    lines.append("The test period has only 3 years, so differences of a few percent are within noise.")
    return lines


def main():
    df = build_features()
    train, val, test = split(df)
    print(f"rows: train {len(train)}, validation {len(val)}, test {len(test)}")

    sat = load_satellite()
    have_sat = not sat.empty
    feature_sets = dict(FEATURE_SETS)
    skipped = {}
    if not have_sat:
        skipped["csv_weather_satellite"] = (f"no satellite data ({SATELLITE_CSV} missing or has no usable MODIS "
                                            f"{SAT_SEASON} rows); run satellite_gee.py first")
        feature_sets.pop("csv_weather_satellite")
        print("WARNING: " + skipped["csv_weather_satellite"])

    val_results, _ = evaluate(train, val, feature_sets)
    test_results, test_preds = evaluate(train, test, feature_sets)
    test_common = test[test["yield_lag1"].notna()]
    sat_cov = float(test_common[SAT_FEATURES[0]].notna().mean()) if len(test_common) and have_sat else 0.0

    # choose the deployed configuration on VALIDATION only
    candidates = {k: v for k, v in val_results.items() if not k.startswith("baseline")}
    best_key = min(candidates, key=lambda k: candidates[k]["rmse_log"]) if candidates else None

    report = {
        "model_version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "split": {"train": f"<= {TRAIN_END}", "validation": list(VAL_YEARS), "test": list(TEST_YEARS),
                  "n_train": int(len(train)), "n_validation": int(len(val)), "n_test": int(len(test)),
                  "n_test_scored": int(len(test_common))},
        "target": "log(yield kg/ha)",
        "feature_sets": {k: v for k, v in feature_sets.items()},
        "skipped": skipped,
        "satellite": {"season_window": SAT_SEASON, "sensor": "modis", "test_row_coverage": sat_cov,
                      "district_years_by_source": source_coverage(pd.read_csv(SATELLITE_CSV)) if have_sat else {}},
        "validation": val_results,
        "test": test_results,
        "selected_on_validation": best_key,
        "interpretation": interpret(test_results, sat_cov),
        "notes": [
            "Weather features are calendar-year totals (existing pipeline) and may include months after some harvests.",
            "Metrics are on test rows that have a last-year yield so every model and baseline sees identical rows.",
        ],
    }

    # Sentinel-2-only baseline: 2017-2019 is too short for a proper split, so train on 2017-18, test 2019.
    if os.path.exists(SATELLITE_CSV):
        s2 = pd.read_csv(SATELLITE_CSV)
        s2 = s2[(s2.source == "sentinel2") & (s2.season == SAT_SEASON) & (s2.n_obs > 0)]
        if len(s2):
            from tn_features import SAT_BASE
            base = add_history_features(load_training())
            s2df = add_satellite_features(base, s2[["district", "year"] + SAT_BASE], train_end=2018)
            tr, te = s2df[s2df.year.between(2017, 2018)], s2df[s2df.year == 2019]
            tr = tr[tr[SAT_FEATURES[0]].notna()]
            fs = {"csv_weather_sentinel2": FEATURE_SETS["csv_weather_satellite"]}
            r, _ = evaluate(tr, te[te[SAT_FEATURES[0]].notna()], fs)
            report["sentinel2_small_sample_baseline"] = {
                "label": "SMALL-SAMPLE BASELINE: Sentinel-2 only, train 2017-18, test 2019. Not comparable to the "
                         "main results and not suitable for deployment.",
                "n_train": int(len(tr)), "results": r}

    os.makedirs("model", exist_ok=True)
    if best_key:
        algo, fs_name = best_key.split("/")
        cols = feature_sets[fs_name]
        fit_rows = pd.concat([train, val])
        model = make_models()[algo]
        Xf, enc = encode(fit_rows, cols)
        model.fit(Xf, np.log(fit_rows["yield"]))
        clim = satellite_climatology(sat, VAL_YEARS[1]) if have_sat else None
        tm = test_results.get(best_key, {})
        with open(BUNDLE, "wb") as f:
            pickle.dump({"model": model, "encoder": enc, "features": cols, "algorithm": algo,
                         "feature_set": fs_name, "version": MODEL_VERSION, "fitted_through": VAL_YEARS[1],
                         "satellite_climatology": clim, "typical_error_pct": tm.get("mape_pct"),
                         "test_metrics": tm, "trained_at": report["trained_at"]}, f)
        report["deployed"] = {"config": best_key, "fitted_on_years": f"<= {VAL_YEARS[1]}",
                              "typical_error_pct": tm.get("mape_pct")}
        print(f"Deployed (selected on validation): {best_key}; test MAPE {tm.get('mape_pct', float('nan')):.1f}%")

    with open(REPORT, "w") as f:
        json.dump(report, f, indent=2, default=lambda o: None if (isinstance(o, float) and np.isnan(o)) else str(o))
    test_preds.to_csv(PREDICTIONS, index=False)

    print("\nTEST (rows with last-year yield):")
    for k, v in test_results.items():
        print(f"  {k:<48} MAE {v['mae_kg_ha']:>9.1f}  RMSE {v['rmse_kg_ha']:>9.1f}  MAPE {v['mape_pct']:>6.1f}%  "
              f"R2(log) {v['r2_log']:.3f}")
    print("\n" + "\n".join(report["interpretation"]))
    print(f"\nWrote {REPORT}, {PREDICTIONS}" + (f", {BUNDLE}" if best_key else ""))


if __name__ == "__main__":
    main()
