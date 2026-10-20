const districtSelect = document.getElementById("district-select");
const cropSelect = document.getElementById("crop-select");
const form = document.getElementById("farm-form");
const errorBox = document.getElementById("form-error");
const results = document.getElementById("results");
const locationInput = document.getElementById("location-input");
const locationResults = document.getElementById("location-results");
const locationSelected = document.getElementById("location-selected");

let selectedLocation = null; // { name, admin1, country, latitude, longitude }
let searchDebounce = null;

districtSelect.addEventListener("change", () => {
  const crops = cropsByDistrict[districtSelect.value] || [];
  cropSelect.innerHTML = "";
  crops.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c.charAt(0) + c.slice(1).toLowerCase();  // "DRY CHILLIES" -> "Dry chillies"
    cropSelect.appendChild(opt);
  });
  cropSelect.disabled = crops.length === 0;
});

locationInput.addEventListener("input", () => {
  selectedLocation = null;
  locationSelected.style.display = "none";
  const query = locationInput.value.trim();
  clearTimeout(searchDebounce);
  if (query.length < 2) {
    locationResults.style.display = "none";
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search-location?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      renderLocationResults(data.results || []);
    } catch (err) {
      locationResults.style.display = "none";
    }
  }, 350);
});

function renderLocationResults(matches) {
  if (matches.length === 0) {
    locationResults.style.display = "none";
    return;
  }
  locationResults.innerHTML = "";
  matches.forEach((m) => {
    const item = document.createElement("div");
    item.className = "location-result-item";
    item.innerHTML = `${m.name}<small>${[m.admin1, m.country].filter(Boolean).join(", ")} · ${m.latitude.toFixed(3)}, ${m.longitude.toFixed(3)}</small>`;
    item.addEventListener("click", () => {
      selectedLocation = m;
      locationInput.value = `${m.name}, ${m.admin1 || m.country}`;
      locationResults.style.display = "none";
      locationSelected.style.display = "block";
      locationSelected.textContent = `✓ Using exact coordinates for ${m.name} (${m.latitude.toFixed(4)}, ${m.longitude.toFixed(4)}) — not the district headquarters.`;
    });
    locationResults.appendChild(item);
  });
  locationResults.style.display = "block";
}

document.addEventListener("click", (e) => {
  if (!locationInput.contains(e.target) && !locationResults.contains(e.target)) {
    locationResults.style.display = "none";
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.style.display = "none";
  const btn = document.getElementById("predict-btn");
  btn.disabled = true;
  btn.textContent = "Fetching live weather...";

  const payload = {
    district: districtSelect.value,
    crop: cropSelect.value,
    area: parseFloat(document.getElementById("area-input").value),
  };
  if (selectedLocation) {
    payload.farm_lat = selectedLocation.latitude;
    payload.farm_lon = selectedLocation.longitude;
    payload.farm_location_name = `${selectedLocation.name}, ${selectedLocation.admin1 || selectedLocation.country}`;
  }

  try {
    const res = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    renderResults(data);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Get Forecast";
  }
});

function renderResults(data) {
  results.style.display = "block";

  const locNote = document.getElementById("location-used-note");
  if (data.used_exact_location) {
    locNote.className = "notice good";
    locNote.textContent = `📍 Weather fetched for your exact farm location: ${data.location_label} (${data.farm_lat.toFixed(4)}, ${data.farm_lon.toFixed(4)})`;
  } else {
    locNote.className = "notice warn";
    locNote.textContent = `⚠ Using the ${data.location_label} coordinates as an approximation — enter your exact village/town above for hyper-local accuracy.`;
  }

  document.getElementById("predicted-yield").textContent = data.recommendation.predicted_yield_kg_per_ha.toLocaleString();
  document.getElementById("historical-yield").textContent = data.recommendation.historical_avg_yield_kg_per_ha
    ? data.recommendation.historical_avg_yield_kg_per_ha.toLocaleString()
    : "—";
  document.getElementById("current-temp").textContent = data.current_weather.temperature ?? "—";
  document.getElementById("current-humidity").textContent = data.current_weather.humidity ?? "—";

  const list = document.getElementById("recommendation-list");
  list.innerHTML = "";
  data.recommendation.advice.forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  });

  const trend = data.historical_trend;
  Plotly.newPlot("trend-chart", [{
    x: trend.years,
    y: trend.yields,
    type: "scatter",
    mode: "lines+markers",
    line: { color: "#2F8F5B", width: 3 },
    marker: { size: 6 },
  }], {
    margin: { t: 10, r: 10, l: 50, b: 40 },
    height: 280,
    yaxis: { title: "Yield (kg/ha)" },
    xaxis: { title: "Year", dtick: 1 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
  }, { displayModeBar: false, responsive: true });

  const ph = data.prediction_history || [];
  const monthLabel = (ym) => {
    const [y, mo] = ym.split("-");
    return new Date(+y, +mo - 1).toLocaleString("en", { month: "short" }) + " " + y.slice(2);
  };
  const phX = ph.map((p) => monthLabel(p.month));
  const histAvg = data.recommendation.historical_avg_yield_kg_per_ha;
  Plotly.newPlot("prediction-history-chart", [
    { x: phX, y: ph.map((p) => p.predicted), type: "scatter", mode: "lines+markers", name: "Forecast at month-end",
      line: { color: "#2F8F5B", width: 3 }, marker: { size: 7 } },
    ...(histAvg ? [{ x: phX, y: phX.map(() => histAvg), type: "scatter", mode: "lines", name: "District historical average",
      line: { color: "#999", width: 2, dash: "dash" } }] : []),
  ], {
    margin: { t: 10, r: 20, l: 60, b: 60 },
    height: 300,
    yaxis: { title: "Predicted yield (kg/ha)" },
    legend: { orientation: "h", y: -0.25 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
  }, { displayModeBar: false, responsive: true });

  const mw = data.monthly_weather || [];
  const labels = mw.map((m) => {
    const [y, mo] = m.month.split("-");
    return new Date(+y, +mo - 1).toLocaleString("en", { month: "short" }) + " " + y.slice(2);
  });
  Plotly.newPlot("monthly-chart", [
    { x: labels, y: mw.map((m) => m.rainfall), type: "bar", name: "Rainfall (mm)", marker: { color: "#5B9BD5" } },
    { x: labels, y: mw.map((m) => m.et0), type: "scatter", mode: "lines+markers", name: "Evapotranspiration (mm)", line: { color: "#E0A030", width: 2 } },
    { x: labels, y: mw.map((m) => m.avg_temp), type: "scatter", mode: "lines+markers", name: "Avg temperature (°C)", yaxis: "y2", line: { color: "#D9534F", width: 2 } },
  ], {
    margin: { t: 10, r: 50, l: 50, b: 60 },
    height: 320,
    yaxis: { title: "mm per month" },
    yaxis2: { title: "°C", overlaying: "y", side: "right", showgrid: false },
    legend: { orientation: "h", y: -0.25 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
  }, { displayModeBar: false, responsive: true });

  results.scrollIntoView({ behavior: "smooth" });
}
