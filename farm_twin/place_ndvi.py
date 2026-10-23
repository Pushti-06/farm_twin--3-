"""Per-zone Sentinel-2 NDVI for the 3D place twin.
Add to app.py (after `app = Flask(...)`):
    import place_ndvi; place_ndvi.register(app)
Needs GEE_PROJECT set and `earthengine authenticate` done (same as satellite_gee.py)."""
import time
from datetime import date, timedelta
from flask import jsonify, request

_cache = {}

def register(app):
    @app.route("/api/place-ndvi")
    def place_ndvi():
        try:
            lat = float(request.args["lat"]); lon = float(request.args["lon"]); half = float(request.args.get("half", 750))
        except Exception:
            return jsonify(ok=False, error="lat/lon required"), 400
        key = (round(lat, 3), round(lon, 3), int(half))
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return jsonify(hit[1])
        try:
            import math, ee
            from satellite_gee import init_ee
            init_ee()
            dlat = half / 110574.0; dlon = half / (111320.0 * math.cos(math.radians(lat)))
            region = ee.Geometry.Rectangle([lon - dlon, lat - dlat, lon + dlon, lat + dlat], None, False)
            end = date.today(); start = end - timedelta(days=30)

            def mask(img):
                scl = img.select("SCL")
                ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(1)).And(scl.neq(0))
                return img.updateMask(ok).normalizedDifference(["B8", "B4"]).rename("ndvi").copyProperties(img, ["system:time_start"])

            col = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(region)
                   .filterDate(start.isoformat(), (end + timedelta(days=1)).isoformat())
                   .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 60)))
            n = col.size().getInfo()
            if n == 0:
                return jsonify(ok=False, error="no Sentinel-2 scene in the last 30 days (cloud cover)")
            proj = col.first().select("B8").projection()
            ndvi = col.map(mask).median().setDefaultProjection(proj)
            last = ee.Date(col.aggregate_max("system:time_start")).format("YYYY-MM-dd").getInfo()
            img = ndvi.reduceResolution(ee.Reducer.mean(), maxPixels=1024).reproject(crs="EPSG:4326", scale=50)
            arr = img.sampleRectangle(region=region, defaultValue=-9999).get("ndvi").getInfo()
            grid = [[(None if (v is None or v < -1) else round(v, 3)) for v in row] for row in arr]
            out = dict(ok=True, scenes=n, latest=last, window_days=30, rows=len(grid), cols=len(grid[0]) if grid else 0,
                       bbox=[lon - dlon, lat - dlat, lon + dlon, lat + dlat], ndvi=grid, source="Sentinel-2 SR Harmonized, cloud-masked 30-day median, 50 m")
            _cache[key] = (time.time(), out)
            return jsonify(out)
        except Exception as e:
            return jsonify(ok=False, error=str(e)[:300])