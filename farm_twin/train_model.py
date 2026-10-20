"""
Trains a yield-prediction model on data/training_data.csv (real crop yield
data merged with real historical weather). Compares Random Forest and
Gradient Boosting, keeps whichever scores better, and saves it for the app.

Run once, after build_training_dataset.py has produced data/training_data.csv:
    python train_model.py

Produces: model/yield_model.pkl
"""

import csv
import pickle

from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score
from sklearn.preprocessing import LabelEncoder
import numpy as np


def main():
    with open("data/training_data.csv") as f:
        rows = list(csv.DictReader(f))

    if len(rows) < 20:
        print("Not enough training rows — did build_training_dataset.py run successfully?")
        return

    crop_encoder = LabelEncoder()
    district_encoder = LabelEncoder()
    crop_encoder.fit([r["Crop"] for r in rows])
    district_encoder.fit([r["District"] for r in rows])

    X, y = [], []
    for r in rows:
        X.append([
            crop_encoder.transform([r["Crop"]])[0],
            district_encoder.transform([r["District"]])[0],
            float(r["Avg_Temp_C"]),
            float(r["Total_Rainfall_mm"]),
            float(r["Total_ET0_mm"]),
        ])
        y.append(float(r["Yield_kg_per_ha"]))

    # No year feature on purpose: with it the model learns the long-run upward trend
    # and extrapolates it into the present, which biases forecasts high and makes them
    # less responsive to the weather. Crop, district and weather are the only inputs.
    # Yields span ~90 kg/ha (cardamom) to ~100,000 kg/ha (sugarcane), so the model
    # learns log(yield); that keeps small crops from being drowned out by large ones.
    X, y = np.array(X), np.log(np.array(y))
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    candidates = {
        "RandomForest": RandomForestRegressor(n_estimators=200, max_depth=12, random_state=42),
        "GradientBoosting": GradientBoostingRegressor(n_estimators=200, max_depth=4, random_state=42),
    }

    best_name, best_model, best_r2 = None, None, -float("inf")
    for name, model in candidates.items():
        model.fit(X_train, y_train)
        preds = model.predict(X_test)
        r2 = r2_score(y_test, preds)
        mape = float(np.mean(np.abs(np.exp(preds) - np.exp(y_test)) / np.exp(y_test))) * 100
        print(f"{name}: R^2 (log yield) = {r2:.3f}, mean abs. error = {mape:.1f}%")
        if r2 > best_r2:
            best_name, best_model, best_r2 = name, model, r2

    print(f"\nSelected {best_name} (R^2 = {best_r2:.3f} on log yield)")

    with open("model/yield_model.pkl", "wb") as f:
        pickle.dump({
            "model": best_model,
            "model_name": best_name,
            "crop_encoder": crop_encoder,
            "district_encoder": district_encoder,
            "log_target": True,
            "feature_order": ["crop", "district", "avg_temp", "total_rainfall", "total_et0"],
        }, f)

    print("Saved model/yield_model.pkl")


if __name__ == "__main__":
    main()
