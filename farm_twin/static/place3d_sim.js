// Interactive, adaptive simulation on top of the 3D place twin (loaded by place3d.js).
//
// The scene is split into 50 m zones. Each zone gets, from REAL data:
//   land cover  : green vegetation from the satellite image, built-up share from OpenStreetMap footprints
//   terrain     : real elevation (slope drives runoff to lower zones; low spots collect water)
//   start state : the twin's real simulated soil water (from the last 14 days of real weather), shifted by terrain,
//                 and crop vigour from the image greenness, adapted to the latest satellite NDVI anomaly if available
//   weather     : the real Open-Meteo forecast (16 days) or a what-if scenario (dry spell, heatwave, heavy rain, cyclone, custom)
// A daily soil-water balance then runs for every zone (rain, runoff, inflow from higher zones, irrigation, crop ET, drainage).
// Thresholds (drought, heat, waterlogging) raise alerts, and you can click zones to irrigate them and see the effect.
// Everything produced here is a SIMULATION driven by real inputs; it is not a sensor measurement.
(function () {
  "use strict";
  const P = window.PLACE3D;
  if (!P || !P.ctx) return;
  const $ = (id) => document.getElementById(id);
  let C = P.ctx();
  const THREE = C.THREE, HALF = C.HALF, GN = 30, NC = GN * GN, CS = 2 * HALF / GN, CELL_HA = CS * CS / 10000;
  const KC = { RICE: 1.15, SUGARCANE: 1.1, BANANA: 1.1, GROUNDNUT: 0.9, MAIZE: 1.0, COTTON: 0.95, ARECANUT: 1.0 };

  // ------------------------------------------------------------------ settings + state
  const S = { scenario: "forecast", rainC: 10, tmaxC: 34, et0C: 5, DT: 40, HT: 35, WL: 3, WARN: 0.15, irrMm: 30, brush: 1, tool: "select", layer: "sw", day: 0, days: 14, adapt: true, playing: null };
  const cropName = (C.DATA.crop || "").toString().toUpperCase(), KC_CROP = KC[cropName] || 0.95, PADDY = cropName === "RICE";
  const veg = new Float32Array(NC), green = new Float32Array(NC), built = new Float32Array(NC), elev = new Float32Array(NC), relN = new Float32Array(NC), cap = new Float32Array(NC);
  const down = new Int16Array(NC), irrig = new Uint8Array(NC);
  let NDV = null, ZN = new Float32Array(NC).fill(NaN), HIST = [], W = null, FC = null, ALERTS = [], sel = -1, srcNote = "", landNote = "";
  let ovMesh = null, ovTex = null, ovCanvas = null, pillars = null, selLine = null;

  const cx = (i) => -HALF + (i + 0.5) * CS, cz = (j) => -HALF + (j + 0.5) * CS;
  const cellOf = (x, z) => { const i = Math.floor((x + HALF) / CS), j = Math.floor((z + HALF) / CS); return i < 0 || j < 0 || i >= GN || j >= GN ? -1 : j * GN + i; };
  const zoneName = (q) => "R" + (Math.floor(q / GN) + 1) + "C" + ((q % GN) + 1);

  // ------------------------------------------------------------------ land cover + terrain from real data
  function computeLandcover() {
    C = P.ctx(); let noImg = false;
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const q = j * GN + i; let v = 0, g = 0, n = 0, r = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        const x = -HALF + (i + (a + 0.5) / 3) * CS, z = -HALF + (j + (b + 0.5) / 3) * CS, lon = C.toLon(x), lat = C.toLat(z), s = C.greenAt(lon, lat);
        if (s) { v += s.veg > 0.5 ? 1 : 0; g += s.veg; n++; } r += C.relAt(lon, lat);
      }
      if (!n) { noImg = true; veg[q] = 0.5; green[q] = 0.5; } else { veg[q] = v / n; green[q] = g / n; }
      relN[q] = Math.max(-1, Math.min(1, r / 9 / 3)); elev[q] = C.elevAt(C.toLon(cx(i)), C.toLat(cz(j)));
    }
    // built-up share from OpenStreetMap footprints
    built.fill(0);
    const bl = C.buildings || [];
    if (bl.length) {
      const R = 300, cv = document.createElement("canvas"); cv.width = cv.height = R; const g = cv.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#000";
      bl.forEach((b) => { const pts = b.geometry; if (!pts || pts.length < 3) return; g.beginPath(); pts.forEach((p, k) => { const x = (C.wx(p.lon) + HALF) / (2 * HALF) * R, y = (C.wz(p.lat) + HALF) / (2 * HALF) * R; k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.fill(); });
      const d = g.getImageData(0, 0, R, R).data, px = R / GN;
      for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) { let s = 0; for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) s += d[(((j * px + y) * R) + i * px + x) * 4 + 3]; built[j * GN + i] = s / 255 / (px * px); }
    }
    for (let q = 0; q < NC; q++) { cap[q] = Math.max(20, 150 * (1 - Math.min(1, built[q]))); if (built[q] > 0.3) veg[q] = Math.min(veg[q], 0.3); }
    // lowest neighbour (D8) for runoff routing
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const q = j * GN + i; let best = -1, be = elev[q] - 0.3;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= GN || jj >= GN) continue; const e = elev[jj * GN + ii]; if (e < be) { be = e; best = jj * GN + ii; } }
      down[q] = best;
    }
    landNote = (noImg ? "Satellite pixels unavailable: land cover assumed 50% vegetation. " : "") + (C.hasDEM ? "" : "Terrain unavailable: flat ground, no runoff routing. ") + (bl.length ? "" : "No OpenStreetMap buildings loaded: built-up share is 0.");
  }

  // ------------------------------------------------------------------ weather
  async function loadNdvi() {
    try {
      const j = await (await fetch("/api/place-ndvi?lat=" + C.lat0.toFixed(5) + "&lon=" + C.lon0.toFixed(5) + "&half=" + HALF)).json();
      if (!j || !j.ok || !j.ndvi || !j.ndvi.length) { NDV = { err: (j && j.error) || "unavailable" }; return; }
      const R = j.rows, K = j.cols; ZN.fill(NaN); let n = 0;
      for (let jj = 0; jj < GN; jj++) for (let ii = 0; ii < GN; ii++) {
        let s = 0, c = 0; for (let r = Math.floor(jj * R / GN); r < Math.max(Math.floor(jj * R / GN) + 1, Math.floor((jj + 1) * R / GN)); r++) for (let k = Math.floor(ii * K / GN); k < Math.max(Math.floor(ii * K / GN) + 1, Math.floor((ii + 1) * K / GN)); k++) { const v = j.ndvi[Math.min(r, R - 1)][Math.min(k, K - 1)]; if (v != null) { s += v; c++; } }
        if (c) { ZN[jj * GN + ii] = s / c; n++; }
      }
      NDV = n ? { latest: j.latest, scenes: j.scenes, n } : { err: "no cloud-free pixels" };
    } catch (e) { NDV = { err: "service unreachable" }; }
  }
  function fmtDate(d) { const t = new Date(); t.setDate(t.getDate() + d); return t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  async function loadForecast() {
    try {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + C.lat0.toFixed(4) + "&longitude=" + C.lon0.toFixed(4) + "&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max&forecast_days=16&timezone=auto");
      const j = (await r.json()).daily; if (!j || !j.time) throw new Error("no daily");
      FC = { rain: j.precipitation_sum.map((v) => v || 0), et0: j.et0_fao_evapotranspiration.map((v) => (v == null ? 4.5 : v)), tmax: j.temperature_2m_max.map((v) => (v == null ? 33 : v)) };
    } catch (e) { FC = null; }
  }
  function makeWeather() {
    S.days = S.scenario === "forecast" ? 15 : 30;
    const N = S.days, w = { rain: [], et0: [], tmax: [] }; srcNote = "";
    for (let d = 0; d <= N; d++) {
      let r = 0, e = 5, t = 34;
      if (S.scenario === "forecast") { if (FC && d < FC.rain.length) { r = FC.rain[d]; e = FC.et0[d]; t = FC.tmax[d]; } else { r = 0; e = 4.5; t = 33; } }
      else if (S.scenario === "dry") { r = 0; e = 5.8; t = 36; }
      else if (S.scenario === "heat") { r = 0; e = 7; t = 40 + (d % 3); }
      else if (S.scenario === "rain") { r = d === 2 ? 90 : d === 3 ? 60 : 2; e = 3; t = 29; }
      else if (S.scenario === "cyclone") { r = d === 3 ? 150 : d === 4 ? 120 : d === 5 ? 40 : 4; e = 2.5; t = 28; }
      else { r = S.rainC; e = S.et0C; t = S.tmaxC; }
      w.rain.push(r); w.et0.push(e); w.tmax.push(t);
    }
    if (S.scenario === "forecast") srcNote = FC ? "Real Open-Meteo forecast for this location (" + Math.min(S.days + 1, FC.rain.length) + " days)." : "Forecast service unreachable: using a dry, average-weather placeholder; choose a what-if scenario instead.";
    else srcNote = "What-if scenario (synthetic weather): " + ({ dry: "dry spell", heat: "heatwave", rain: "heavy rain", cyclone: "cyclone", custom: "custom" })[S.scenario] + ".";
    W = w;
  }

  // ------------------------------------------------------------------ simulation
  function snap() { return { sw: new Float32Array(NC), v: new Float32Array(NC), dr: new Uint8Array(NC), ht: new Uint8Array(NC), wl: new Uint8Array(NC), inflow: new Float32Array(NC), irr: new Float32Array(NC), et: new Float32Array(NC), rain: 0, et0: 0, tmax: 0 }; }
  function simulate() {
    const N = S.days, base = C.DATA.twin_state.soil_water_mm, an = C.DSTATE && C.DSTATE.observed && C.DSTATE.observed.satellite && C.DSTATE.observed.satellite.anomaly;
    const adaptK = S.adapt && an && an.pct != null ? Math.max(0.5, Math.min(1.2, 1 + an.pct / 100)) : 1;
    const SW = new Float32Array(NC), V = new Float32Array(NC), wlc = new Uint8Array(NC); let inflow = new Float32Array(NC);
    for (let q = 0; q < NC; q++) { SW[q] = Math.max(0, Math.min(cap[q], (built[q] > 0.3 ? 0.3 : 1) * (base - 20 * relN[q]))); V[q] = veg[q] > 0.25 ? (NDV && NDV.n && !isNaN(ZN[q]) ? Math.max(0.05, Math.min(1, (ZN[q] - 0.15) / 0.65)) : Math.max(0.05, Math.min(1, (0.35 + 0.6 * green[q]) * adaptK))) : 0; }
    HIST = []; const t0 = (C.DATA.current_weather || {}).temp_max || 33;
    const mk = (d, rain, et0, tmax, inf, irrA, etA) => { const h = snap(); h.sw.set(SW); h.v.set(V); h.rain = rain; h.et0 = et0; h.tmax = tmax; if (inf) h.inflow.set(inf); if (irrA) h.irr.set(irrA); if (etA) h.et.set(etA);
      for (let q = 0; q < NC; q++) { const crop = veg[q] > 0.25; h.dr[q] = crop && SW[q] < S.DT ? 1 : 0; h.ht[q] = crop && tmax >= S.HT ? 1 : 0; h.wl[q] = crop && wlc[q] >= S.WL ? 1 : 0; } HIST.push(h); };
    mk(0, 0, W.et0[0], t0, null, null, null);
    for (let d = 1; d <= N; d++) {
      const rain = W.rain[d], et0 = W.et0[d], tmax = W.tmax[d], next = new Float32Array(NC), irrA = new Float32Array(NC), etA = new Float32Array(NC), inf = inflow;
      for (let q = 0; q < NC; q++) {
        const imp = Math.min(1, built[q] * 0.9); let ro = rain * imp;
        const irr = irrig[q] && d % 3 === 1 ? S.irrMm : 0; irrA[q] = irr;
        SW[q] += rain * (1 - imp) + inf[q] + irr;
        const kc = ((1 - veg[q]) * 0.3 + veg[q] * KC_CROP * (0.4 + 0.6 * V[q])) * (1 - 0.8 * Math.min(1, built[q])), et = et0 * kc * Math.min(1, SW[q] / (0.5 * cap[q]));
        etA[q] = Math.min(SW[q], et); SW[q] = Math.max(0, SW[q] - et);
        if (SW[q] > 0.85 * cap[q]) SW[q] -= Math.min(3, SW[q] - 0.85 * cap[q]);
        if (SW[q] > cap[q]) { const x = SW[q] - cap[q]; if (down[q] >= 0) { ro += x * 0.7; SW[q] = cap[q]; } else SW[q] = Math.min(cap[q] * 1.25, SW[q]); }
        if (ro > 0 && down[q] >= 0) next[down[q]] += ro * 0.7;
        if (veg[q] > 0.25) {
          const drought = SW[q] < S.DT, heat = tmax >= S.HT, full = SW[q] >= 0.95 * cap[q] && (rain * (1 - imp) + inf[q]) >= 8;
          wlc[q] = full ? Math.min(30, wlc[q] + 1) : 0; const wl = !PADDY && wlc[q] >= S.WL;
          if (drought) V[q] -= 0.04 * (1 - 0.5 * SW[q] / S.DT); if (heat) V[q] -= 0.025; if (wl) V[q] -= 0.02;
          if (!drought && !heat && !wl && SW[q] > 0.4 * cap[q]) V[q] += 0.015 * (1 - V[q]);
          V[q] = Math.max(0, Math.min(1, V[q]));
        }
      }
      mk(d, rain, et0, tmax, inf, irrA, etA); inflow = next;
    }
    if (PADDY) HIST.forEach((h) => h.wl.fill(0));
    makeAlerts();
  }

  // ------------------------------------------------------------------ alerts
  function vegHa() { let n = 0; for (let q = 0; q < NC; q++) if (veg[q] > 0.25) n++; return n * CELL_HA; }
  function makeAlerts() {
    ALERTS = []; const total = vegHa() || 1, rules = [
      ["drought", "below the drought threshold (" + S.DT + " mm)", (h) => h.dr], ["heat", "exposed to heat stress (Tmax ≥ " + S.HT + " °C)", (h) => h.ht], ["waterlog", "waterlogged (soil full for " + S.WL + "+ days)", (h) => h.wl]];
    rules.forEach(([key, text, get]) => {
      let prev = 0;
      HIST.forEach((h, d) => {
        const f = get(h); let n = 0, first = -1; for (let q = 0; q < NC; q++) if (f[q]) { n++; if (first < 0) first = q; }
        const share = n * CELL_HA / total, lvl = n === 0 ? 0 : share >= Math.max(0.4, S.WARN * 2.5) ? 3 : share >= S.WARN ? 2 : 1;
        if (lvl > prev) ALERTS.push({ day: d, key, level: lvl, ha: n * CELL_HA, share, zone: first, text: (d === 0 ? "Now" : "Day " + d + " (" + fmtDate(d) + ")") + ": " + (n * CELL_HA).toFixed(1) + " ha (" + Math.round(share * 100) + "% of green land) " + text + (first >= 0 ? ", first zone " + zoneName(first) : "") });
        prev = lvl;
      });
    });
    // crop vigour loss alert
    const v0 = meanV(HIST[0]); let pv = 0;
    HIST.forEach((h, d) => { if (!d) return; const loss = v0 ? (v0 - meanV(h)) / v0 : 0, lvl = loss >= 0.25 ? 3 : loss >= 0.12 ? 2 : loss >= 0.05 ? 1 : 0; if (lvl > pv) ALERTS.push({ day: d, key: "vigour", level: lvl, ha: 0, share: loss, zone: -1, text: "Day " + d + " (" + fmtDate(d) + "): modelled crop vigour is " + Math.round(loss * 100) + "% below today's level" }); pv = lvl; });
    ALERTS.sort((a, b) => a.day - b.day || b.level - a.level);
  }
  function meanV(h) { let s = 0, n = 0; for (let q = 0; q < NC; q++) if (veg[q] > 0.25) { s += h.v[q]; n++; } return n ? s / n : 0; }
  const LV = ["", "watch", "warning", "critical"];

  // ------------------------------------------------------------------ 3D overlay, pillars, selection
  const RAMP = [[0, [224, 90, 90]], [0.27, [240, 179, 74]], [0.5, [201, 221, 106]], [0.75, [61, 220, 132]], [1, [79, 209, 232]]];
  function ramp(f) { f = Math.max(0, Math.min(1, f)); for (let i = 1; i < RAMP.length; i++) if (f <= RAMP[i][0]) { const t = (f - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]), a = RAMP[i - 1][1], b = RAMP[i][1]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; } return RAMP[4][1]; }
  function buildOverlay() {
    C = P.ctx(); if (!C.terrain) return;
    if (ovMesh) { C.world.remove(ovMesh); ovMesh.geometry.dispose(); ovMesh = null; }
    if (pillars) { C.world.remove(pillars); pillars.geometry.dispose(); pillars = null; }
    const tg = C.terrain.geometry, pos = tg.getAttribute("position"), uv = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k++) { uv[k * 2] = (pos.getX(k) + HALF) / (2 * HALF); uv[k * 2 + 1] = 1 - (pos.getZ(k) + HALF) / (2 * HALF); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", pos); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.setIndex(tg.getIndex());
    if (!ovCanvas) { ovCanvas = document.createElement("canvas"); ovCanvas.width = ovCanvas.height = GN; ovTex = new THREE.CanvasTexture(ovCanvas); ovTex.encoding = THREE.sRGBEncoding; ovTex.minFilter = ovTex.magFilter = THREE.LinearFilter; ovTex.generateMipmaps = false; }
    ovMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: ovTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    ovMesh.position.y = 0.3; ovMesh.renderOrder = 4; ovMesh.frustumCulled = false; C.world.add(ovMesh);
    pillars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false }), NC); pillars.frustumCulled = false; pillars.renderOrder = 6; pillars.count = 0; C.world.add(pillars);
    drawSel(); paint();
  }
  function paint() {
    if (!ovCanvas || !HIST.length) return;
    const h = HIST[S.day], g = ovCanvas.getContext("2d"), im = g.createImageData(GN, GN), L = S.layer;
    for (let q = 0; q < NC; q++) {
      let c = null, a = 0; const isVeg = veg[q] > 0.25;
      if (L === "sw") { c = ramp(h.sw[q] / cap[q]); a = isVeg ? 0.72 : 0.3; }
      else if (L === "vigour") { if (isVeg) { c = ramp(h.v[q] * 0.85 + 0.0); a = 0.72; } }
      else if (L === "drought") { if (isVeg) { if (h.dr[q]) { c = [224, 70, 70]; a = 0.8; } else if (h.sw[q] < S.DT * 1.3) { c = [240, 179, 74]; a = 0.6; } else { c = [61, 180, 120]; a = 0.25; } } }
      else if (L === "waterlog") { if (isVeg) { if (h.wl[q]) { c = [40, 110, 220]; a = 0.8; } else if (h.sw[q] > 0.85 * cap[q]) { c = [100, 170, 230]; a = 0.55; } } }
      else if (L === "irrigation") { if (irrig[q]) { c = [70, 200, 240]; a = 0.75; } }
      if (c) { im.data[q * 4] = c[0]; im.data[q * 4 + 1] = c[1]; im.data[q * 4 + 2] = c[2]; im.data[q * 4 + 3] = Math.round(a * 255); }
    }
    g.putImageData(im, 0, 0); ovTex.needsUpdate = true; if (ovMesh) ovMesh.visible = L !== "off";
    if (L !== "off") P.setMode("sat");
    // alert pillars
    const m = new THREE.Matrix4(), col = new THREE.Color(); let n = 0;
    for (let q = 0; q < NC; q++) {
      const kind = h.dr[q] ? 0 : h.wl[q] ? 1 : h.ht[q] ? 2 : -1; if (kind < 0) continue;
      const i = q % GN, j = Math.floor(q / GN), x = cx(i), z = cz(j), y = C.Yat(C.toLon(x), C.toLat(z)), ht = 26;
      m.compose(new THREE.Vector3(x, y + ht / 2, z), new THREE.Quaternion(), new THREE.Vector3(CS * 0.55, ht, CS * 0.55)); pillars.setMatrixAt(n, m); col.setHex(kind === 0 ? 0xff3b3b : kind === 1 ? 0x2f7fe0 : 0xff9f1a); pillars.setColorAt(n, col); n++;
    }
    pillars.count = n; pillars.instanceMatrix.needsUpdate = true; if (pillars.instanceColor) pillars.instanceColor.needsUpdate = true;
    const el = h.rain >= 8 ? "rain" : h.tmax >= S.HT ? "heat" : h.rain >= 1 ? "cloudy" : "clear"; C.look(el);
    renderPanel();
  }
  function drawSel() {
    if (selLine) { C.world.remove(selLine); selLine.geometry.dispose(); selLine = null; }
    if (sel < 0) return; const i = sel % GN, j = Math.floor(sel / GN), x0 = -HALF + i * CS, z0 = -HALF + j * CS, pts = [], M = 8, edge = (ax, az, bx, bz) => { for (let k = 0; k < M; k++) { const t = k / M, x = ax + (bx - ax) * t, z = az + (bz - az) * t; pts.push(new THREE.Vector3(x, C.Yat(C.toLon(x), C.toLat(z)) + 1, z)); } };
    edge(x0, z0, x0 + CS, z0); edge(x0 + CS, z0, x0 + CS, z0 + CS); edge(x0 + CS, z0 + CS, x0, z0 + CS); edge(x0, z0 + CS, x0, z0);
    selLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false })); selLine.renderOrder = 9; selLine.frustumCulled = false; C.world.add(selLine);
  }

  // ------------------------------------------------------------------ interaction
  P.simPick = (hit) => {
    const q = cellOf(hit.point.x, hit.point.z); if (q < 0) return false;
    if (S.tool === "irrigate") {
      const r = S.brush - 1, i0 = q % GN, j0 = Math.floor(q / GN), on = !irrig[q];
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const i = i0 + di, j = j0 + dj; if (i >= 0 && j >= 0 && i < GN && j < GN) irrig[j * GN + i] = on ? 1 : 0; }
      run(); return true;
    }
    sel = q; drawSel(); renderPanel(); return true;
  };
  P.onTerrain = () => { buildOverlay(); };
  P.onBuildings = () => { computeLandcover(); run(); };

  function run() { C = P.ctx(); makeWeather(); simulate(); S.day = Math.min(S.day, S.days); const sl = $("ps-day"); if (sl) { sl.max = S.days; sl.value = S.day; } paint(); }
  function flyTo(q) { const i = q % GN, j = Math.floor(q / GN), x = cx(i), z = cz(j); C = P.ctx(); C.controls.target.set(x, C.Yat(C.toLon(x), C.toLat(z)), z); C.camera.position.set(x, 220, z + 260); C.controls.update(); }

  // ------------------------------------------------------------------ UI
  function build() {
    const anchor = $("place3d-report"); if (!anchor) return;
    const box = document.createElement("div"); box.id = "p3sim"; box.className = "ps";
    box.innerHTML = `
<h3 class="ps-h">Interactive twin: simulate, see what affects each zone, get alerts</h3>
<p class="muted" style="margin:0 0 8px">The scene is split into 50 m zones. Each starts from real data (satellite greenness, OpenStreetMap buildings, real terrain, the twin's real soil-water state) and a daily water balance then runs forward with the real forecast or a what-if scenario. Click a zone to inspect it.</p>
<div class="ps-row"><button id="ps-play" class="p3-btn">▶ Play</button><input id="ps-day" type="range" min="0" max="14" value="0" step="1"><b id="ps-daylbl"></b></div>
<div class="ps-row" id="ps-wx"></div>
<div class="ps-row"><label>Weather <select id="ps-scen"><option value="forecast">Real forecast (Open-Meteo)</option><option value="dry">What-if: dry spell</option><option value="heat">What-if: heatwave</option><option value="rain">What-if: heavy rain</option><option value="cyclone">What-if: cyclone</option><option value="custom">What-if: custom</option></select></label>
<span id="ps-custom" style="display:none"><label>rain/day <input id="ps-cr" type="range" min="0" max="60" value="10"><b id="ps-crv">10</b> mm</label> <label>Tmax <input id="ps-ct" type="range" min="25" max="46" value="34"><b id="ps-ctv">34</b>°C</label> <label>ET₀ <input id="ps-ce" type="range" min="1" max="9" step="0.5" value="5"><b id="ps-cev">5</b></label></span></div>
<div class="ps-row"><span class="ps-lbl">Layer</span><div class="p3-modes" id="ps-layers"><button data-l="sw" class="on">Soil water</button><button data-l="vigour">Crop vigour</button><button data-l="drought">Drought</button><button data-l="waterlog">Waterlogging</button><button data-l="irrigation">Irrigation</button><button data-l="off">Off</button></div></div>
<div class="ps-row"><span class="ps-lbl">Click tool</span><div class="p3-modes" id="ps-tools"><button data-t="select" class="on">Inspect zone</button><button data-t="irrigate">Irrigate zones</button></div>
<label>brush <select id="ps-brush"><option value="1">1 zone</option><option value="2">3×3</option><option value="3">5×5</option></select></label>
<label>amount <input id="ps-irr" type="range" min="10" max="60" value="30" step="5"><b id="ps-irrv">30</b> mm / 3 days</label>
<button id="ps-auto" class="p3-btn">Irrigate zones that hit drought</button><button id="ps-clear" class="p3-btn">Clear irrigation</button></div>
<details class="ps-th" open><summary>Alert thresholds (change them and the alerts update)</summary>
<label>Drought below <input id="ps-dt" type="range" min="20" max="80" value="40"><b id="ps-dtv">40</b> mm</label>
<label>Heat at <input id="ps-ht" type="range" min="32" max="42" value="35"><b id="ps-htv">35</b> °C</label>
<label>Waterlogging after <input id="ps-wl" type="range" min="1" max="7" value="3"><b id="ps-wlv">3</b> days full</label>
<label>Warning when <input id="ps-wn" type="range" min="5" max="50" value="15"><b id="ps-wnv">15</b>% of green land is affected</label>
<label><input type="checkbox" id="ps-adapt" checked> Adapt crop vigour to the latest satellite NDVI anomaly</label></details>
<div id="ps-kpis" class="p3-kpis"></div>
<div class="ps-cols"><div><div class="ps-sec">Zone inspector</div><div id="ps-insp" class="ps-card"></div><div class="ps-sec">Observed vs simulated</div><div id="ps-obs" class="ps-card"></div></div>
<div><div class="ps-sec">Alerts <button id="ps-acsv" class="p3-go">Export CSV</button></div><div id="ps-alerts" class="ps-card"></div><div class="ps-note" id="ps-note"></div></div></div>`;
    anchor.parentNode.insertBefore(box, anchor);
    const tg = document.createElement("div"); tg.id = "p3-toast"; tg.className = "p3-toast"; tg.style.display = "none"; $("place3d-view").appendChild(tg);
    wire();
  }
  function wire() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("ps-day", "input", (e) => { S.day = +e.target.value; paint(); });
    on("ps-play", "click", () => { if (S.playing) { clearInterval(S.playing); S.playing = null; $("ps-play").textContent = "▶ Play"; return; } if (S.day >= S.days) S.day = 0; $("ps-play").textContent = "❚❚ Pause"; S.playing = setInterval(() => { if (S.day >= S.days) { clearInterval(S.playing); S.playing = null; $("ps-play").textContent = "▶ Play"; return; } S.day++; $("ps-day").value = S.day; paint(); }, 900); });
    on("ps-scen", "change", (e) => { S.scenario = e.target.value; $("ps-custom").style.display = S.scenario === "custom" ? "inline" : "none"; S.day = 0; run(); });
    [["ps-cr", "rainC", "ps-crv"], ["ps-ct", "tmaxC", "ps-ctv"], ["ps-ce", "et0C", "ps-cev"], ["ps-dt", "DT", "ps-dtv"], ["ps-ht", "HT", "ps-htv"], ["ps-wl", "WL", "ps-wlv"], ["ps-irr", "irrMm", "ps-irrv"]].forEach(([id, k, out]) => on(id, "input", (e) => { S[k] = +e.target.value; $(out).textContent = e.target.value; run(); }));
    on("ps-wn", "input", (e) => { S.WARN = +e.target.value / 100; $("ps-wnv").textContent = e.target.value; run(); });
    on("ps-adapt", "change", (e) => { S.adapt = e.target.checked; run(); });
    on("ps-brush", "change", (e) => { S.brush = +e.target.value; });
    $("ps-layers").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.layer = b.dataset.l; document.querySelectorAll("#ps-layers button").forEach((x) => x.classList.toggle("on", x === b)); paint(); });
    $("ps-tools").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.tool = b.dataset.t; document.querySelectorAll("#ps-tools button").forEach((x) => x.classList.toggle("on", x === b)); if (S.tool === "irrigate") { S.layer = "irrigation"; document.querySelectorAll("#ps-layers button").forEach((x) => x.classList.toggle("on", x.dataset.l === "irrigation")); paint(); } });
    on("ps-auto", "click", () => { let any = false; HIST.forEach((h) => { for (let q = 0; q < NC; q++) if (h.dr[q]) { irrig[q] = 1; any = true; } }); if (any) { run(); } });
    on("ps-clear", "click", () => { irrig.fill(0); run(); });
    on("ps-acsv", "click", () => { const rows = ALERTS.map((a) => [a.day, a.key, LV[a.level], a.ha.toFixed(2), '"' + a.text.replace(/"/g, "'") + '"'].join(",")); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["day,type,level,hectares,message\n" + rows.join("\n")], { type: "text/csv" })); a.download = "place_alerts.csv"; document.body.appendChild(a); a.click(); a.remove(); });
    $("ps-alerts").addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (!li) return; const a = ALERTS[+li.dataset.i]; S.day = Math.min(a.day, S.days); $("ps-day").value = S.day; if (a.zone >= 0) { sel = a.zone; drawSel(); flyTo(a.zone); } paint(); });
  }

  function spark(q) {
    const W_ = 260, H = 60, N = S.days, vals = HIST.map((h) => h.sw[q]), mx = Math.max(cap[q], ...vals) * 1.05, X = (d) => 4 + d / N * (W_ - 8), Yv = (v) => H - 4 - v / mx * (H - 8);
    const d = vals.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Yv(v).toFixed(1)).join(" ");
    return `<svg viewBox="0 0 ${W_} ${H}" class="ps-spark"><line x1="0" x2="${W_}" y1="${Yv(S.DT).toFixed(1)}" y2="${Yv(S.DT).toFixed(1)}" stroke="#e05a5a" stroke-dasharray="4 3"/><path d="${d}" fill="none" stroke="#2F8F5B" stroke-width="2"/><circle cx="${X(S.day).toFixed(1)}" cy="${Yv(vals[S.day]).toFixed(1)}" r="4" fill="#f0b34a"/></svg>`;
  }
  function renderPanel() {
    if (!HIST.length || !$("ps-kpis")) return;
    const h = HIST[S.day], tot = vegHa(); let dr = 0, ht = 0, wl = 0, ir = 0, vol = 0;
    for (let q = 0; q < NC; q++) { if (h.dr[q]) dr++; if (h.ht[q]) ht++; if (h.wl[q]) wl++; if (irrig[q]) ir++; }
    for (let d = 1; d <= S.day; d++) for (let q = 0; q < NC; q++) vol += HIST[d].irr[q] * CELL_HA * 10;
    const k = (l, v, c) => `<div class="${c || ""}"><span>${l}</span><b>${v}</b></div>`;
    $("ps-daylbl").textContent = (S.day === 0 ? "Today" : "Day " + S.day) + " · " + fmtDate(S.day);
    $("ps-wx").innerHTML = `<span class="ps-chip">rain <b>${h.rain.toFixed(1)}</b> mm</span><span class="ps-chip">ET₀ <b>${h.et0.toFixed(1)}</b> mm</span><span class="ps-chip">Tmax <b>${h.tmax.toFixed(1)}</b> °C</span><span class="ps-src">${srcNote}</span>`;
    $("ps-kpis").innerHTML = k("Green land", tot.toFixed(1) + " ha") + k("Below drought threshold", (dr * CELL_HA).toFixed(1) + " ha", "k-bad") + k("Heat exposed", (ht * CELL_HA).toFixed(1) + " ha", "k-warn") + k("Waterlogged", (wl * CELL_HA).toFixed(1) + " ha", "k-wet") + k("Mean crop vigour", Math.round(meanV(h) * 100) + "%") + k("Irrigated", (ir * CELL_HA).toFixed(1) + " ha · " + Math.round(vol) + " m³");
    // alerts
    const upto = ALERTS.map((a, i) => [a, i]).filter(([a]) => a.day <= S.day);
    $("ps-alerts").innerHTML = ALERTS.length ? ALERTS.map((a, i) => `<div class="ps-al l${a.level}${a.day > S.day ? " future" : ""}" data-i="${i}"><span class="ps-badge">${LV[a.level]}</span> ${a.text}</div>`).join("") : "<div class='muted'>No threshold is crossed in this period. Try a dry spell, heatwave or heavy-rain scenario, or lower the thresholds.</div>";
    const tg = $("p3-toast"); const last = upto.filter(([a]) => a.level >= 2).pop();
    if (tg) { if (last) { tg.className = "p3-toast l" + last[0].level; tg.textContent = "ALERT · " + last[0].text; tg.style.display = "block"; } else tg.style.display = "none"; }
    $("ps-note").textContent = srcNote + " " + landNote;
    // inspector
    const insp = $("ps-insp");
    if (sel < 0) insp.innerHTML = "<div class='muted'>Click a zone on the 3D view (with the Inspect tool selected).</div>";
    else {
      const q = sel; let rain7 = 0, inf7 = 0, irr7 = 0, et7 = 0; for (let d = Math.max(1, S.day - 6); d <= S.day; d++) { const x = HIST[d]; rain7 += x.rain * (1 - Math.min(1, built[q] * 0.9)); inf7 += x.inflow[q]; irr7 += x.irr[q]; et7 += x.et[q]; }
      const flags = [h.dr[q] ? "<span class='ps-badge l3'>drought</span>" : "", h.ht[q] ? "<span class='ps-badge l2'>heat</span>" : "", h.wl[q] ? "<span class='ps-badge l1w'>waterlogged</span>" : ""].join(" ") || "<span class='ps-badge l0'>no stress</span>";
      insp.innerHTML = `<b>Zone ${zoneName(q)}</b> · ${C.toLat(cz(Math.floor(q / GN))).toFixed(5)}, ${C.toLon(cx(q % GN)).toFixed(5)} · ${Math.round(elev[q])} m<br>Cover: ${Math.round(veg[q] * 100)}% green, ${Math.round(built[q] * 100)}% built-up${irrig[q] ? " · <b>irrigated</b>" : ""}<br>Soil water <b>${Math.round(h.sw[q])}</b> of ${Math.round(cap[q])} mm · crop vigour <b>${Math.round(h.v[q] * 100)}%</b><br>${flags}
        <div class="ps-sub">What is driving it (last ${Math.min(7, S.day)} days): rain ${rain7.toFixed(0)} mm · runoff received ${inf7.toFixed(0)} mm · irrigation ${irr7.toFixed(0)} mm · crop water use ${et7.toFixed(0)} mm${relN[q] < -0.3 ? " · low spot, collects water" : relN[q] > 0.3 ? " · rise, drains faster" : ""}</div>${spark(q)}<div class="muted" style="font-size:11px">Soil water, days 0-${S.days}. Dashed line = drought threshold.</div>`;
    }
    // observed vs simulated
    const an = C.DSTATE && C.DSTATE.observed && C.DSTATE.observed.satellite && C.DSTATE.observed.satellite.anomaly, vEnd = meanV(HIST[S.days]), v0 = meanV(HIST[0]), drEnd = HIST[S.days].dr.reduce((a, b) => a + b, 0) * CELL_HA / (tot || 1);
    let o = NDV && NDV.n ? `<b>Zone crop vigour is set from real Sentinel-2 NDVI</b> (latest scene ${NDV.latest}, ${NDV.scenes} scenes, 50 m zones).<br>` : `<span class='muted'>Per-zone Sentinel-2 NDVI not used: ${NDV && NDV.err ? NDV.err : "loading"}.</span><br>`;
    if (an && an.pct != null) {
      o += `District satellite (MODIS, vs 2000-2019 normal for the date): NDVI <b>${an.pct > 0 ? "+" : ""}${an.pct.toFixed(0)}%</b> (z ${an.z != null ? an.z.toFixed(1) : "n/a"}).<br>Twin forecast: vigour ${Math.round(v0 * 100)}% → ${Math.round(vEnd * 100)}%, ${Math.round(drEnd * 100)}% of green land below the drought threshold by day ${S.days}.<br>`;
      const sat = an.z != null && an.z <= -1;
      o += sat && drEnd < 0.05 ? "<b>Check in the field:</b> the satellite shows below-normal greenness but the water balance shows no water stress, so the cause may be something else (pests, nutrients, sowing date)." : sat ? "Satellite and water balance agree that the crop is under pressure." : drEnd >= 0.15 ? "The satellite is normal today, but the forecast water balance shows stress building." : "Satellite and water balance both show no clear stress.";
      o += S.adapt ? "<div class='muted' style='font-size:11px'>The starting vigour was adapted to this anomaly.</div>" : "";
    } else o += "<div class='muted'>No district satellite anomaly is available (satellite data not loaded for this district), so the twin starts from image greenness only.</div>";
    $("ps-obs").innerHTML = o;
    if (P.sim && P.sim.onPaint) { try { P.sim.onPaint(); } catch (e) { console.error(e); } }
  }

  // gentle pulse on the alert pillars
  (function loop(t) { requestAnimationFrame(loop); if (pillars && pillars.material) pillars.material.opacity = 0.38 + 0.22 * Math.sin(t / 400); })(0);

  P.sim = { get S() { return S; }, get hist() { return HIST; }, get alerts() { return ALERTS; }, get sel() { return sel; }, get cap() { return cap; }, get veg() { return veg; }, GN, cx, cz, zoneName, flyTo, rerun: run, onPaint: null, vegHa, meanV, select(q) { sel = q; drawSel(); renderPanel(); }, setDay(d) { S.day = Math.max(0, Math.min(S.days, d)); const sl = $("ps-day"); if (sl) sl.value = S.day; paint(); } };
  async function boot() {
    C = P.ctx(); build(); computeLandcover(); await Promise.all([loadForecast(), loadNdvi()]); buildOverlay(); run(); setTimeout(() => { try { run(); } catch (e) {} }, 5000);
  }
  boot();
})();