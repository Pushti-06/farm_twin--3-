// District observed twin panel: OBSERVED (satellite + weather) | SIMULATED (soil water) | PREDICTED (yield),
// a data-status line and alert notifications. Mounted into <div id="observed-panel"> on the dashboard and
// twin pages. Real and simulated values live in separate, differently-styled blocks.
(function () {
  const root = document.getElementById("observed-panel");
  if (!root) return;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 2) => (v == null || isNaN(v)) ? null : Number(v).toFixed(d);
  const na = t => '<span class="obs-missing">' + t + "</span>";
  const row = (k, v) => '<div class="obs-row"><span>' + k + "</span><span>" + v + "</span></div>";
  const sub = t => '<div class="obs-sub">' + t + "</div>";
  const cap = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const when = iso => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const pill = lvl => '<span class="obs-pill lvl-' + esc(lvl) + '">' + esc(lvl) + "</span>";

  // Dashboard: notification list only (all districts, newest first). The full panel lives on the Digital Twin page.
  if (root.dataset.mode === "alerts") {
    const loadList = async () => {
      try {
        const a = (await (await fetch("/api/alerts?limit=8")).json()).alerts || [];
        root.innerHTML = a.length ? a.map(x =>
          '<div class="obs-feed-item lvl-' + esc(x.level) + '">' + pill(x.level) +
          "<span><b>" + esc(cap(x.district)) + "</b>" + (x.crop ? " · " + esc(cap(x.crop)) : "") + "</span>" +
          '<span class="obs-feed-time">' + esc(when(x.timestamp)) + "</span>" +
          '<span class="obs-feed-ev">' + (x.evidence || []).filter(e => e.points).map(e => esc(e.indicator) + ": " + esc(e.value)).join(" · ") + "</span></div>").join("")
          : na("No alerts raised. All districts are within their normal range, or data has not been refreshed yet.");
      } catch (e) { root.innerHTML = na("alerts unavailable"); }
    };
    loadList();
    setInterval(loadList, 5 * 60 * 1000);
    return;
  }

  let district = root.dataset.district || "";
  let districts = [];
  let showAll = false;

  root.innerHTML =
    '<div class="obs-head"><label>District <select id="obs-district"></select></label>' +
    '<button type="button" id="obs-refresh" class="obs-btn">Refresh observations</button>' +
    '<span id="obs-updated" class="obs-updated"></span></div>' +
    '<div id="obs-alert"></div><div id="obs-body"></div>' +
    '<div class="obs-feed-head"><h3>History — retained observations and predictions</h3></div><div id="obs-history"></div>' +
    '<div class="obs-feed-head"><h3 id="obs-feed-title">Recent alerts</h3>' +
    '<label><input type="checkbox" id="obs-all"> all districts</label></div><div id="obs-feed"></div>';

  const sel = document.getElementById("obs-district");

  function alertBox(a) {
    if (!a) return "";
    const ev = (a.evidence || []).filter(e => e.points).map(e =>
      "<li><b>" + esc(e.indicator) + "</b> <em class=\"" + (e.kind === "simulated" ? "tag-sim\">simulated" : "tag-obs\">observed") + "</em>: " +
      esc(e.value) + ' <span class="obs-missing">(' + esc(e.source || "") + (e.date ? ", " + esc(e.date) : "") + ")</span></li>").join("");
    return '<div class="obs-alert lvl-' + esc(a.level) + '">' + pill(a.level) +
      "<div><div>" + esc(a.message) + "</div>" + (a.level !== "none" && ev ? "<ul>" + ev + "</ul>" : "") + "</div></div>";
  }

  function satelliteBlock(sat) {
    if (!sat) return na("no satellite observation");
    const s2 = sat.sentinel2 || {}, m = sat.modis, an = sat.anomaly;
    let h = "";
    if (s2.ndvi != null) {
      h += row("Sentinel-2 NDVI · EVI · LSWI", num(s2.ndvi) + " · " + num(s2.evi) + " · " + num(s2.lswi));
      h += row("Scenes · cloud-free cropland", esc(s2.n_scenes) + " · " + (s2.cloud_free_fraction != null ? Math.round(s2.cloud_free_fraction * 100) + "%" : "n/a"));
      h += row("Acquired", esc(s2.first_acquisition) + " → " + esc(s2.last_acquisition));
    } else {
      h += row("Sentinel-2", na(s2.status === "no_scene" ? "no scene in 16 days" : "no cloud-free scene in 16 days"));
    }
    h += m ? row("MODIS NDVI · EVI · LSWI (" + esc(m.date) + ")", num(m.ndvi) + " · " + num(m.evi) + " · " + num(m.lswi)) : row("MODIS", na("no composite"));
    h += an ? row("NDVI vs normal for the date", num(an.pct, 0) + "% (z " + num(an.z, 1) + ")") : row("NDVI vs normal for the date", na("not available"));
    return h;
  }

  function weatherBlock(wx) {
    if (!wx) return na("no weather data");
    const rain = (a, n) => num(a, 0) + " mm · normal " + (n != null ? num(n, 0) + " mm" : '<span class="obs-missing">n/a</span>');
    return row("Rain, last 14 days", rain(wx.actual_14, wx.normal_14)) +
      row("Rain, last 30 days", rain(wx.actual_30, wx.normal_30)) +
      row("Consecutive dry days", esc(wx.dry_days)) +
      row("Hot days (≥ 35 °C), last 5", esc(wx.heat_days_5)) +
      row("ET0, last 7 days", wx.et0_7 != null ? num(wx.et0_7, 1) + " mm" : na("n/a"));
  }

  function body(s) {
    const o = s.observed || {}, sat = o.satellite, wx = o.weather, sim = s.simulated, pred = s.predicted;
    const fresh = s.data_freshness || {};
    const wf = fresh.weather || {}, sf = fresh.satellite || {};

    const cs = s.crop_season;
    const status = '<div class="obs-status">' + (cs ? "Crop season: <b>" + esc(cs.label) + " " + esc(cs.agri_year) + "</b> · " : "") + 'Data status — satellite: <b>' +
      esc((sat && sat.status && sat.status.text) || sf.status || "no satellite observation") + "</b> · weather: <b>" +
      esc(wf.latest_data_date ? "up to " + wf.latest_data_date : (wf.status || "no data")) + "</b></div>";

    const simHtml = sim
      ? row("Soil water", num(sim.soil_water_mm, 0) + " of " + esc(sim.soil_water_capacity_mm) + " mm (" + num(sim.soil_water_fill_pct, 0) + "%)") +
        row("Status", esc(sim.status))
      : na("not simulated yet");

    let predHtml;
    if (!pred) predHtml = na("not computed yet — runs with the daily satellite refresh");
    else if (pred.yield_kg_ha == null) predHtml = na("no prediction: " + esc(pred.reason || "unavailable"));
    else {
      predHtml = row("Main crop", esc(cap(pred.crop))) +
        row("Predicted yield", num(pred.yield_kg_ha, 0) + " kg/ha") +
        (pred.typical_error_pct != null ? row("Typical test error", "± " + num(pred.typical_error_pct, 0) + "%") : "") +
        row("Model", esc(pred.model_version) + " · fitted to " + esc(pred.fitted_through)) +
        (pred.notes || []).map(n => '<div class="obs-missing obs-note">' + esc(n) + "</div>").join("");
    }

    return status + '<div class="obs-cols">' +
      '<div class="obs-col obs-observed"><h3>Observed<small>measured by satellite and weather services</small></h3>' +
      sub("Satellite") + satelliteBlock(sat) + sub("Weather") + weatherBlock(wx) + "</div>" +
      '<div class="obs-col obs-simulated"><h3>Simulated<small>soil-water model — not a measurement</small></h3>' + simHtml + "</div>" +
      '<div class="obs-col obs-predicted"><h3>Predicted<small>ML yield forecast</small></h3>' + predHtml + "</div></div>";
  }

  // Temporal twin: snapshots kept over time, newest first, plus a per-season comparison of mean NDVI.
  async function loadHistory() {
    const el = document.getElementById("obs-history");
    try {
      const h = (await (await fetch("/api/tn/history/" + encodeURIComponent(district) + "?limit=40")).json()).history || [];
      if (!h.length) { el.innerHTML = na("no snapshots yet — one is stored per day and whenever a new satellite date, prediction or alert level appears"); return; }
      const groups = {};
      h.forEach(x => { if (x.ndvi != null) { const k = x.season + " " + x.agri_year; (groups[k] = groups[k] || []).push(x.ndvi); } });
      const cmp = Object.keys(groups).map(k => esc(k) + ": mean NDVI " + num(groups[k].reduce((a, b) => a + b, 0) / groups[k].length) + " (" + groups[k].length + " obs)");
      const rows = h.slice().reverse().slice(0, 8).map(x =>
        "<tr><td>" + esc(x.date) + "</td><td>" + esc(x.season) + " " + esc(x.agri_year) + "</td><td>" +
        (x.ndvi != null ? num(x.ndvi) + ' <span class="obs-missing">' + esc(x.satellite_source) + " " + esc(x.satellite_date) + "</span>" : na("none")) + "</td><td>" +
        (x.predicted_yield != null ? num(x.predicted_yield, 0) + " kg/ha " + esc(cap(x.predicted_crop || "")) : na("none")) + "</td><td>" + pill(x.alert_level || "none") + "</td></tr>").join("");
      el.innerHTML = (cmp.length ? '<div class="obs-status">Season comparison — ' + cmp.join(" · ") + "</div>" : '<div class="obs-status">' + na("no satellite NDVI retained yet, so no season comparison") + "</div>") +
        '<table class="obs-table"><thead><tr><th>Date</th><th>Season</th><th>NDVI</th><th>Predicted yield</th><th>Alert</th></tr></thead><tbody>' + rows + "</tbody></table>";
    } catch (e) { el.innerHTML = na("history unavailable"); }
  }

  async function loadFeed() {
    const q = "/api/alerts?limit=5" + (!showAll && district ? "&district=" + encodeURIComponent(district) : "");
    document.getElementById("obs-feed-title").textContent = "Recent alerts" + (!showAll && district ? " — " + cap(district) : "");
    try {
      const a = (await (await fetch(q)).json()).alerts || [];
      document.getElementById("obs-feed").innerHTML = a.length ? a.map(x =>
        '<div class="obs-feed-item lvl-' + esc(x.level) + '">' + pill(x.level) +
        "<span>" + (showAll ? "<b>" + esc(cap(x.district)) + "</b>" : "") + (x.crop ? (showAll ? " · " : "") + esc(cap(x.crop)) : "") + "</span>" +
        '<span class="obs-feed-time">' + esc(when(x.timestamp)) + "</span>" +
        '<span class="obs-feed-ev">' + (x.evidence || []).filter(e => e.points).map(e => esc(e.indicator) + ": " + esc(e.value)).join(" · ") + "</span></div>").join("")
        : na("No alerts raised" + (!showAll && district ? " for this district." : "."));
    } catch (e) { /* feed is optional */ }
  }

  async function load() {
    if (!district) return;
    const upd = document.getElementById("obs-updated");
    try {
      const r = await fetch("/api/tn/district/" + encodeURIComponent(district));
      const s = await r.json();
      if (!r.ok) {
        document.getElementById("obs-body").innerHTML = '<div class="obs-status">' + na(esc(s.error || "no data")) + "</div>";
        document.getElementById("obs-alert").innerHTML = ""; upd.textContent = "";
      } else {
        document.getElementById("obs-alert").innerHTML = alertBox(s.alert);
        document.getElementById("obs-body").innerHTML = body(s);
        upd.textContent = s.updated_at ? "updated " + when(s.updated_at) : "";
      }
    } catch (e) { document.getElementById("obs-body").innerHTML = na("could not reach the server"); }
    loadHistory();
    loadFeed();
  }

  async function init() {
    try { districts = (await (await fetch("/api/tn/districts")).json()).districts || []; } catch (e) { districts = []; }
    sel.innerHTML = districts.map(d => '<option value="' + esc(d.district) + '">' + esc(cap(d.district)) +
      (d.level && d.level !== "none" && d.level !== "unknown" ? " ⚠ " + esc(d.level) : "") + "</option>").join("");
    const ds = document.getElementById("district-select");
    // dashboard: its district picker; twin page: the district of the latest forecast, else the last choice made
    if (!district && ds && ds.value) district = ds.value;
    if (!district) {
      try { const t = await (await fetch("/api/twin-state")).json(); if (t && t.ready && t.district) district = t.district; } catch (e) { }
    }
    if (!district) { try { district = sessionStorage.getItem("obsDistrict") || ""; } catch (e) { } }
    if (!district || !districts.some(d => d.district === district)) district = (districts[0] && districts[0].district) || "";
    if (district) sel.value = district;
    load();
  }

  const remember = () => { try { sessionStorage.setItem("obsDistrict", district); } catch (e) { } };
  sel.addEventListener("change", () => { district = sel.value; remember(); load(); });
  document.getElementById("obs-all").addEventListener("change", e => { showAll = e.target.checked; loadFeed(); });
  const ds = document.getElementById("district-select");
  if (ds) ds.addEventListener("change", () => { if (ds.value) { district = ds.value; sel.value = district; remember(); load(); } });

  document.getElementById("obs-refresh").addEventListener("click", async () => {
    const btn = document.getElementById("obs-refresh"), upd = document.getElementById("obs-updated");
    btn.disabled = true; upd.textContent = "refreshing all districts in the background…";
    try { await fetch("/api/tn/refresh", { method: "POST" }); } catch (e) { }
    let n = 0;
    const t = setInterval(async () => { await load(); if (++n >= 8) { clearInterval(t); btn.disabled = false; } }, 15000);
  });

  init();
  setInterval(load, 5 * 60 * 1000);
})();
