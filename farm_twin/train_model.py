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
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.preprocessing import LabelEncoder
import numpy as np


def main():
    with open("data/training_data.csv") as f:
        rows = list(csv.DictReader(f))

    if len(rows) < 20:
        print("Not enough training rows — did build_training_dataset.py run successfully?")
        return

    crop_encoder = LabelEncoder()
    state_encoder = LabelEncoder()
    crops = [r["Crop"] for r in rows]
    states = [r["State"] for r in rows]
    crop_encoder.fit(crops)
    state_encoder.fit(states)

    X, y = [], []
    for r in rows:
        X.append([
            crop_encoder.transform([r["Crop"]])[0],
            state_encoder.transform([r["State"]])[0],
            float(r["Year"]),
            float(r["Area_1000ha"]),
            float(r["Avg_Temp_C"]),
            float(r["Total_Rainfall_mm"]),
            float(r["Total_ET0_mm"]) if r["Total_ET0_mm"] else 0.0,
        ])
        y.append(float(r["Yield_kg_per_ha"]))

    X, y = np.array(X), np.array(y)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    candidates = {
        "RandomForest": RandomForestRegressor(n_estimators=200, max_depth=12, random_state=42),
        "GradientBoosting": GradientBoostingRegressor(n_estimators=200, max_depth=4, random_state=42),
    }

    best_name, best_model, best_r2 = None, None, -float("inf")
    for name, model in candidates.items():
        model.fit(X_train, y_train)
        preds = model.predict(X_test)
        mae = mean_absolute_error(y_test, preds)
        r2 = r2_score(y_test, preds)
        print(f"{name}: R^2 = {r2:.3f}, MAE = {mae:.1f} kg/ha")
        if r2 > best_r2:
            best_name, best_model, best_r2 = name, model, r2

    print(f"\nSelected {best_name} (R^2 = {best_r2:.3f})")

    with open("model/yield_model.pkl", "wb") as f:
        pickle.dump({
            "model": best_model,
            "model_name": best_name,
            "crop_encoder": crop_encoder,
            "state_encoder": state_encoder,
            "feature_order": ["crop", "state", "year", "area_1000ha", "avg_temp", "total_rainfall", "total_et0"],
        }, f)

    print("Saved model/yield_model.pkl")


if __name__ == "__main__":
    main()
