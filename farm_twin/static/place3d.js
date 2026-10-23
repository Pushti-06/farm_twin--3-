// 3D twin of the actual place (not an invented farm).
//
//  * Ground     : real satellite imagery (Esri World Imagery, zoom 17) draped over real terrain (AWS Terrarium / SRTM).
//  * Buildings  : real footprints from OpenStreetMap (Overpass API), extruded to their tagged height/levels (default 6 m).
//  * Twin layer : the twin's simulated root-zone water (from live weather) painted onto the green vegetation found in the
//                 imagery, and redistributed a little by terrain (low spots wetter, rises drier). Rain/clouds/heat follow
//                 the live weather and the what-if buttons.
//  Everything is rendered in the browser around the farm location chosen on the Dashboard / Tamil Nadu page.
(function () {
  "use strict";
  const SELF_SRC = (document.currentScript && document.currentScript.src) || "";
  const $ = (id) => document.getElementById(id);
  const host = $("place3d-view");
  if (!host || !window.THREE) return;

  const SAT_URL = (z, x, y) => "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/" + z + "/" + y + "/" + x;
  const ELEV_URL = (z, x, y) => "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/" + z + "/" + x + "/" + y + ".png";
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  const HALF = 750, ZS = 17, ZE = 14, TILE = 256, CAP = 150, D2R = Math.PI / 180;

  let DATA = null, lat0 = 0, lon0 = 0, KX = 1, KY = 1;
  let renderer, scene, camera, controls, world, terrain, buildingsMesh = null, overlayMesh = null, marker, rain, sun, amb, clouds = 0;
  let ELEV = null, SAT = null, REL = null, ex = 3, mode = "twin", bld = [], bldOn = true;
  let vegTex = null, allTex = null, vegFrac = 0, scenario = { name: "live", delta: 0 }, raycaster = new THREE.Raycaster();
  let down = null, clockT = 0;

  const mx = (lon) => (lon + 180) / 360;
  const my = (lat) => { const s = Math.sin(lat * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const mxToLon = (x) => x * 360 - 180;
  const myToLat = (y) => Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y)) / D2R;
  const wx = (lon) => (lon - lon0) * KX;
  const wz = (lat) => -(lat - lat0) * KY;
  const toLon = (x) => lon0 + x / KX;
  const toLat = (z) => lat0 - z / KY;

  function grid(bb, z) {
    const n = 1 << z, x0 = Math.floor(mx(bb.lonmin) * n), x1 = Math.floor(mx(bb.lonmax) * n), y0 = Math.floor(my(bb.latmax) * n), y1 = Math.floor(my(bb.latmin) * n);
    return { z, n, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
  }
  function loadImg(url, retry) {
    return new Promise((res, rej) => {
      const im = new Image(); im.crossOrigin = "anonymous"; let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; im.src = ""; retry ? loadImg(url, retry - 1).then(res, rej) : rej(new Error("tile timeout")); }, 12000);
      im.onload = () => { if (done) return; done = true; clearTimeout(timer); res(im); };
      im.onerror = () => { if (done) return; done = true; clearTimeout(timer); retry ? loadImg(url, retry - 1).then(res, rej) : rej(new Error("tile")); };
      im.src = url;
    });
  }
  async function streamTiles(T, urlFn, onTile, progress) {
    const list = []; for (let j = 0; j < T.ny; j++) for (let i = 0; i < T.nx; i++) list.push([i, j]);
    let k = 0, failed = 0, finished = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (k < list.length) { const [i, j] = list[k++];
      try { onTile(await loadImg(urlFn(T.z, T.x0 + i, T.y0 + j), 2), i, j); } catch (e) { failed++; onTile(null, i, j); } finished++; if (progress) progress(finished, list.length, failed); } }));
    return { total: list.length, failed };
  }
  const status = (t) => { const e = $("place3d-status"); if (e) e.textContent = t; };

  // ------------------------------------------------------------ elevation
  async function loadElevation(bb) {
    const T = grid(bb, ZE), W = T.nx * TILE, H = T.ny * TILE, data = new Float32Array(W * H);
    const c = document.createElement("canvas"); c.width = c.height = TILE; const g = c.getContext("2d", { willReadFrequently: true });
    const r = await streamTiles(T, ELEV_URL, (img, i, j) => { if (!img) return; g.clearRect(0, 0, TILE, TILE); g.drawImage(img, 0, 0);
      const p = g.getImageData(0, 0, TILE, TILE).data;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const k = (y * TILE + x) * 4; data[(j * TILE + y) * W + i * TILE + x] = p[k] * 256 + p[k + 1] + p[k + 2] / 256 - 32768; } }, (d, t) => status("Streaming terrain " + d + " / " + t));
    if (r.failed > r.total / 2) return null;
    // relative elevation: this point minus the mean of a ~7x7 pixel (~65 m) window
    const rel = new Float32Array(W * H), R = 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; s += data[yy * W + xx]; n++; } }
      rel[y * W + x] = data[y * W + x] - s / n; }
    return { T, W, H, data, rel };
  }
  function sampleE(arr, lon, lat) {
    if (!ELEV) return 0;
    const fx = Math.min(ELEV.W - 1.001, Math.max(0, mx(lon) * ELEV.T.n * TILE - ELEV.T.x0 * TILE - 0.5)), fy = Math.min(ELEV.H - 1.001, Math.max(0, my(lat) * ELEV.T.n * TILE - ELEV.T.y0 * TILE - 0.5));
    const x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y, W = ELEV.W;
    return (arr[y * W + x] * (1 - tx) + arr[y * W + x + 1] * tx) * (1 - ty) + (arr[(y + 1) * W + x] * (1 - tx) + arr[(y + 1) * W + x + 1] * tx) * ty;
  }
  const elevAt = (lon, lat) => sampleE(ELEV && ELEV.data, lon, lat);
  const Yat = (lon, lat) => (elevAt(lon, lat) - baseElev) * ex;
  let baseElev = 0;

  // ------------------------------------------------------------ imagery + twin overlay textures
  function tex(canvas, srgb) {
    const t = new THREE.CanvasTexture(canvas); if (srgb) t.encoding = THREE.sRGBEncoding;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; return t;
  }
  const RAMP = [[0, [224, 90, 90]], [0.27, [240, 179, 74]], [0.5, [201, 221, 106]], [0.75, [61, 220, 132]], [1, [79, 209, 232]]];
  function ramp(f) {
    f = Math.max(0, Math.min(1, f));
    for (let i = 1; i < RAMP.length; i++) if (f <= RAMP[i][0]) { const t = (f - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]), a = RAMP[i - 1][1], b = RAMP[i][1]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    return RAMP[RAMP.length - 1][1];
  }
  function effectiveFill() {
    const base = DATA.twin_state.soil_water_mm;
    return Math.max(0, Math.min(CAP, base + scenario.delta)) / CAP;
  }
  function buildOverlays() {
    if (!SAT || !SAT.ok) return;
    const OW = 1024, OH = Math.round(OW * SAT.canvas.height / SAT.canvas.width);
    const c = document.createElement("canvas"); c.width = OW; c.height = OH; const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(SAT.canvas, 0, 0, OW, OH);
    let px; try { px = g.getImageData(0, 0, OW, OH).data; } catch (e) { return; }      // tainted canvas: no overlay
    const f0 = effectiveFill(), T = SAT.T;
    const lons = new Float32Array(OW), lats = new Float32Array(OH);
    for (let i = 0; i < OW; i++) lons[i] = mxToLon((T.x0 + (i + 0.5) / OW * T.nx) / T.n);
    for (let j = 0; j < OH; j++) lats[j] = myToLat((T.y0 + (j + 0.5) / OH * T.ny) / T.n);
    const veg = new Uint8ClampedArray(OW * OH * 4), all = new Uint8ClampedArray(OW * OH * 4);
    let vcount = 0, inside = 0;
    const G = GN, cs = 2 * HALF / G, cn = new Float32Array(G * G), cv = new Float32Array(G * G), cf = new Float32Array(G * G), cfa = new Float32Array(G * G);
    for (let j = 0; j < OH; j++) for (let i = 0; i < OW; i++) {
      const k = (j * OW + i) * 4, r = px[k], gg = px[k + 1], b = px[k + 2], s = r + gg + b + 1, exg = (2 * gg - r - b) / s;
      const inb = Math.abs(lons[i] - lon0) * KX < HALF && Math.abs(lats[j] - lat0) * KY < HALF; if (inb) inside++;
      const t = Math.max(0, Math.min(1, (exg - 0.02) / 0.08)), vm = t * t * (3 - 2 * t);
      if (inb && vm > 0.5) vcount++;
      const rel = ELEV ? sampleE(ELEV.rel, lons[i], lats[j]) : 0, f = f0 - 0.10 * Math.max(-1, Math.min(1, rel / 3)), col = ramp(f);
      if (inb) { const ci = Math.min(G - 1, Math.max(0, Math.floor(((lons[i] - lon0) * KX + HALF) / cs))), cj = Math.min(G - 1, Math.max(0, Math.floor((HALF - (lats[j] - lat0) * KY) / cs))), q = cj * G + ci;
        cn[q]++; cv[q] += vm; cf[q] += f * vm; cfa[q] += f; }
      veg[k] = col[0]; veg[k + 1] = col[1]; veg[k + 2] = col[2]; veg[k + 3] = Math.round(vm * 170);
      all[k] = col[0]; all[k + 1] = col[1]; all[k + 2] = col[2]; all[k + 3] = 175;
    }
    vegFrac = inside ? vcount / inside : 0;
    buildCells(G, cs, inside, cn, cv, cf, cfa);
    const mk = (arr) => { const cc = document.createElement("canvas"); cc.width = OW; cc.height = OH; cc.getContext("2d").putImageData(new ImageData(arr, OW, OH), 0, 0); return tex(cc, true); };
    if (vegTex) vegTex.dispose(); if (allTex) allTex.dispose();
    vegTex = mk(veg); allTex = mk(all); applyMode();
    $("place3d-veg").textContent = Math.round(vegFrac * 100) + "% of the scene is green vegetation in this image";
  }
  // ------------------------------------------------------------ outputs: zonal statistics, report, downloads
  const GN = 10, SCENE_HA = (2 * HALF) * (2 * HALF) / 10000, STRESS = 40 / CAP, WET = 0.75;
  let CELLS = [], SUMMARY = null, DSTATE = null;
  function buildCells(G, cs, inside, cn, cv, cf, cfa) {
    CELLS = []; const haPx = inside ? SCENE_HA / inside : 0;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const q = j * G + i; if (!cn[q]) continue;
      const x = -HALF + (i + 0.5) * cs, z = -HALF + (j + 0.5) * cs, vegHa = cv[q] * haPx, fill = cv[q] > 0.5 ? cf[q] / cv[q] : null, fillAll = cfa[q] / cn[q];
      CELLS.push({ id: j * G + i, row: j, col: i, lat: toLat(z), lon: toLon(x), x, z, elev: Math.round(elevAt(toLon(x), toLat(z))), cellHa: +(cn[q] * haPx).toFixed(2), vegHa: +vegHa.toFixed(2), fill: fill, fillAll });
    }
    let veg = 0, stressed = 0, ok = 0, wet = 0;
    CELLS.forEach((c) => { if (c.fill == null) return; veg += c.vegHa; if (c.fill < STRESS) stressed += c.vegHa; else if (c.fill > WET) wet += c.vegHa; else ok += c.vegHa; });
    SUMMARY = { veg, stressed, ok, wet }; renderReport();
  }
  function ha(v) { return v.toFixed(1) + " ha"; }
  function renderReport() {
    const el = $("place3d-report"); if (!el || !SUMMARY || !DATA) return;
    const S = SUMMARY, share = S.veg ? S.stressed / S.veg : 0, f = effectiveFill();
    let verdict, tone;
    if (!S.veg) { verdict = "No green vegetation was detected in this image, so no crop-water summary is possible."; tone = "muted"; }
    else if (share > 0.5) { verdict = "Most of the green land here is below the drought threshold in the twin. Worth checking these fields."; tone = "bad"; }
    else if (share > 0.2) { verdict = "Part of the green land here is below the drought threshold. Check the driest zones listed below."; tone = "warn"; }
    else { verdict = "No water stress is indicated for the vegetation in this scene."; tone = "good"; }
    const dry = CELLS.filter((c) => c.fill != null && c.vegHa >= 0.5).sort((a, b) => a.fill - b.fill).slice(0, 5);
    const d = DSTATE && DSTATE.alert ? "<div class='p3-dist'>District satellite alert (" + (DSTATE.district || "") + "): <b>" + DSTATE.alert.level + "</b> · " + (DSTATE.alert.message || "") + " · " + ((DSTATE.data_freshness || {}).satellite || {}).status + "</div>" : "";
    el.innerHTML = "<div class='p3-verdict " + tone + "'>" + verdict + "</div>" + d +
      "<div class='p3-kpis'><div><span>Scene</span><b>" + SCENE_HA.toFixed(0) + " ha</b></div><div><span>Green vegetation</span><b>" + ha(S.veg) + "</b></div>" +
      "<div class='k-bad'><span>Below drought threshold</span><b>" + ha(S.stressed) + "</b></div><div class='k-ok'><span>Adequate water</span><b>" + ha(S.ok) + "</b></div><div class='k-wet'><span>Very wet</span><b>" + ha(S.wet) + "</b></div>" +
      "<div><span>Mapped buildings</span><b>" + (bld.length || 0) + "</b></div></div>" +
      "<div class='p3-sub'>Twin soil water " + Math.round(f * CAP) + " mm of " + CAP + " mm (" + document.getElementById('place3d-weather').textContent + "). Driest green zones (150 m cells):</div>" +
      (dry.length ? "<table class='p3-tbl'><tr><th>Zone</th><th>Lat, Lon</th><th>Green</th><th>Modelled water</th><th></th></tr>" + dry.map((c) => "<tr><td>R" + (c.row + 1) + "C" + (c.col + 1) + "</td><td>" + c.lat.toFixed(5) + ", " + c.lon.toFixed(5) + "</td><td>" + c.vegHa.toFixed(1) + " ha</td><td>" + Math.round(c.fill * CAP) + " mm</td><td><button class='p3-go' data-id='" + c.id + "'>Show</button></td></tr>").join("") + "</table>" : "<div class='muted'>No zone with at least 0.5 ha of green vegetation.</div>") +
      "<div class='p3-actions'><button id='p3-csv' class='p3-btn'>Download zones (CSV)</button><button id='p3-geo' class='p3-btn'>Download zones (GeoJSON)</button></div>";
  }
  function download(name, mime, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function zoneRows() { return CELLS.map((c) => ({ zone: "R" + (c.row + 1) + "C" + (c.col + 1), lat: c.lat.toFixed(6), lon: c.lon.toFixed(6), elevation_m: c.elev, cell_ha: c.cellHa, green_vegetation_ha: c.vegHa, modelled_soil_water_mm: c.fill == null ? "" : Math.round(c.fill * CAP), below_drought_threshold: c.fill == null ? "" : c.fill < STRESS })); }
  function flyToCell(id) { const c = CELLS.find((k) => k.id === +id); if (!c) return; controls.target.set(c.x, (c.elev - baseElev) * ex, c.z); camera.position.set(c.x, 260, c.z + 320); controls.update(); }
  async function loadDistrictState() {
    try { const nm = (DATA.district || "").toString().toUpperCase(); if (!nm) return; const j = await (await fetch("/api/tn/district/" + encodeURIComponent(nm))).json(); if (j && j.alert) { DSTATE = j; renderReport(); } } catch (e) { /* optional */ }
  }
  document.addEventListener("click", (e) => {
    if (e.target.id === "p3-csv") { const r = zoneRows(); if (r.length) download("place_zones.csv", "text/csv", Object.keys(r[0]).join(",") + "\n" + r.map((o) => Object.values(o).join(",")).join("\n")); }
    if (e.target.id === "p3-geo") { const cs = 2 * HALF / GN; download("place_zones.geojson", "application/geo+json", JSON.stringify({ type: "FeatureCollection", features: CELLS.map((c) => { const lo = c.lon - cs / 2 / KX, hi = c.lon + cs / 2 / KX, la0 = c.lat - cs / 2 / KY, la1 = c.lat + cs / 2 / KY;
      return { type: "Feature", properties: { zone: "R" + (c.row + 1) + "C" + (c.col + 1), elevation_m: c.elev, green_vegetation_ha: c.vegHa, modelled_soil_water_mm: c.fill == null ? null : Math.round(c.fill * CAP), below_drought_threshold: c.fill == null ? null : c.fill < STRESS }, geometry: { type: "Polygon", coordinates: [[[lo, la0], [hi, la0], [hi, la1], [lo, la1], [lo, la0]]] } }; }) })); }
    const g = e.target.closest(".p3-go"); if (g) flyToCell(g.dataset.id);
  });

  function applyMode() {
    if (!overlayMesh) return;
    overlayMesh.visible = mode !== "sat" && !!vegTex;
    if (mode === "twin") overlayMesh.material.map = vegTex; else if (mode === "moist") overlayMesh.material.map = allTex;
    overlayMesh.material.needsUpdate = true;
    terrain.material.color.setScalar(mode === "moist" ? 0.55 : 1);
    document.querySelectorAll("#place3d-modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("place3d-legend").style.display = mode === "sat" ? "none" : "block";
  }

  // ------------------------------------------------------------ geometry
  function uvFor(T, lon, lat) { return [(mx(lon) * T.n - T.x0) / T.nx, 1 - (my(lat) * T.n - T.y0) / T.ny]; }
  function buildTerrain() {
    if (terrain) { world.remove(terrain); terrain.geometry.dispose(); }
    if (overlayMesh) { world.remove(overlayMesh); overlayMesh.geometry.dispose(); overlayMesh = null; }
    const N = 150, pos = new Float32Array((N + 1) * (N + 1) * 3), uv = new Float32Array((N + 1) * (N + 1) * 2), idx = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = -HALF + 2 * HALF * i / N, z = -HALF + 2 * HALF * j / N, lon = toLon(x), lat = toLat(z), v = j * (N + 1) + i;
      pos.set([x, Yat(lon, lat), z], v * 3); if (SAT) uv.set(uvFor(SAT.T, lon, lat), v * 2);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff, map: SAT && SAT.tex ? SAT.tex : null })); if (!SAT || !SAT.tex) terrain.material.color.set(0x3a4a42);
    world.add(terrain);
    const og = new THREE.BufferGeometry(); og.setAttribute("position", g.getAttribute("position")); og.setAttribute("uv", g.getAttribute("uv")); og.setIndex(g.getIndex());
    overlayMesh = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    overlayMesh.position.y = 0.15; overlayMesh.renderOrder = 2; world.add(overlayMesh); applyMode();
  }
  function ring(coords) { return coords.map((c) => [wx(c.lon), wz(c.lat)]); }
  function buildBuildings() {
    if (buildingsMesh) { world.remove(buildingsMesh); buildingsMesh.geometry.dispose(); buildingsMesh = null; }
    if (!bld.length) return;
    const P = [], N = [];
    let used = 0;
    bld.forEach((b) => {
      let pts = ring(b.geometry); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      if (pts.length < 3 || pts.some((p) => Math.abs(p[0]) > HALF + 60 || Math.abs(p[1]) > HALF + 60)) return;
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const y0 = Yat(toLon(cx), toLat(cz)) - 0.5, t = b.tags || {};
      const h = parseFloat(t.height) || (parseFloat(t["building:levels"]) ? parseFloat(t["building:levels"]) * 3.2 : 6), y1 = y0 + h + 0.5;
      const tri = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
      tri.forEach((f) => f.forEach((i) => P.push(pts[i][0], y1, pts[i][1])));
      for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length];
        P.push(a[0], y0, a[1], c[0], y0, c[1], c[0], y1, c[1], a[0], y0, a[1], c[0], y1, c[1], a[0], y1, a[1]); }
      used++;
    });
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals();
    buildingsMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xe9e4da, side: THREE.DoubleSide, transparent: true, opacity: 0.93 }));
    buildingsMesh.visible = bldOn; buildingsMesh.renderOrder = 3; world.add(buildingsMesh);
    $("place3d-bld").textContent = used + " OpenStreetMap buildings"; renderReport(); if (window.PLACE3D && window.PLACE3D.onBuildings) window.PLACE3D.onBuildings();
  }
  async function loadBuildings() {
    const dLat = HALF / KY, dLon = HALF / KX, q = "[out:json][timeout:30];way[\"building\"](" + (lat0 - dLat) + "," + (lon0 - dLon) + "," + (lat0 + dLat) + "," + (lon0 + dLon) + ");out tags geom 4000;";
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 45000);
        const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal }); clearTimeout(to);
        if (!r.ok) continue; const j = await r.json(); bld = (j.elements || []).filter((e) => e.geometry && e.geometry.length > 3); buildBuildings();
        if (!bld.length) $("place3d-bld").textContent = "no buildings mapped here in OpenStreetMap"; return;
      } catch (e) { /* try next mirror */ }
    }
    $("place3d-bld").textContent = "OpenStreetMap buildings unavailable";
  }

  // ------------------------------------------------------------ weather + scene
  function scene3() {
    renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75)); renderer.outputEncoding = THREE.sRGBEncoding;
    host.insertBefore(renderer.domElement, host.firstChild);
    scene = new THREE.Scene(); scene.background = new THREE.Color(0xbfd8e6); scene.fog = new THREE.Fog(0xbfd8e6, 1200, 3200);
    camera = new THREE.PerspectiveCamera(45, 1, 2, 8000); controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.48; controls.minDistance = 40; controls.maxDistance = 2600; controls.screenSpacePanning = false;
    amb = new THREE.AmbientLight(0xffffff, 0.8); sun = new THREE.DirectionalLight(0xfff2dc, 0.55); sun.position.set(-300, 600, -200); scene.add(amb, sun);
    world = new THREE.Group(); scene.add(world);
    camera.position.set(0, 780, 980); controls.target.set(0, 0, 0);
    const rg = new THREE.BufferGeometry(), n = 3500, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) p.set([(Math.random() - 0.5) * HALF * 2.4, Math.random() * 400, (Math.random() - 0.5) * HALF * 2.4], i * 3);
    rg.setAttribute("position", new THREE.BufferAttribute(p, 3)); rain = new THREE.Points(rg, new THREE.PointsMaterial({ color: 0xcfe8ff, size: 2.2, transparent: true, opacity: 0.7, depthWrite: false })); rain.visible = false; scene.add(rain);
    const rs = () => { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    rs(); new ResizeObserver(rs).observe(host);
    renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    renderer.domElement.addEventListener("pointerup", (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) pick(e); down = null; });
  }
  function setMarker() {
    if (marker) world.remove(marker);
    const g = new THREE.Group(), cyl = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 70, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    cyl.position.y = 35; const ringM = new THREE.Mesh(new THREE.RingGeometry(9, 12, 40), new THREE.MeshBasicMaterial({ color: 0xff4d4d, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ringM.rotation.x = -Math.PI / 2; ringM.position.y = 0.5; g.add(cyl, ringM); g.position.set(0, Yat(lon0, lat0), 0); g.renderOrder = 5; marker = g; world.add(g);
  }
  const SCEN = { live: null, clear: { rain: 0, dark: 0, sky: 0xbfd8e6, sun: 0.55, warm: 0 }, cloudy: { rain: 0, dark: 0.18, sky: 0xaab6bd, sun: 0.3, warm: 0 },
    rain: { rain: 1, dark: 0.3, sky: 0x8c9aa3, sun: 0.2, warm: 0 }, storm: { rain: 1, dark: 0.42, sky: 0x707c84, sun: 0.15, warm: 0 }, heat: { rain: 0, dark: 0, sky: 0xf0cf9a, sun: 0.75, warm: 1 } };
  function liveScenario() {
    const w = DATA.current_weather || {}, wet = (w.precipitation || 0) > 0.1, cloudy = [2, 3, 45, 48].includes(w.weather_code), hot = (w.temp_max || 0) >= 35;
    return wet ? SCEN.rain : hot ? SCEN.heat : cloudy ? SCEN.cloudy : SCEN.clear;
  }
  function applyScenario() {
    const s = SCEN[scenario.name] || liveScenario();
    rain.visible = !!s.rain; scene.background.setHex(s.sky); scene.fog.color.setHex(s.sky); amb.intensity = 0.8 - s.dark; sun.intensity = s.sun;
    sun.color.setHex(s.warm ? 0xffc27a : 0xfff2dc);
    $("place3d-weather").textContent = scenario.name === "live" ? "live weather" : "what-if: " + scenario.name + (scenario.delta ? " (" + (scenario.delta > 0 ? "+" : "") + scenario.delta + " mm)" : "");
    $("place3d-water").textContent = Math.round(Math.max(0, Math.min(CAP, DATA.twin_state.soil_water_mm + scenario.delta))) + " mm of " + CAP + " mm";
    buildOverlays();
  }

  // ------------------------------------------------------------ interaction
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hits = raycaster.intersectObjects([buildingsMesh, terrain].filter(Boolean)), h = hits[0], pop = $("place3d-pop");
    if (!h) { pop.style.display = "none"; return; }
    if (window.PLACE3D && window.PLACE3D.simPick && window.PLACE3D.simPick(h, e)) { pop.style.display = "none"; return; }
    const lon = toLon(h.point.x), lat = toLat(h.point.z), el = elevAt(lon, lat), rel = ELEV ? sampleE(ELEV.rel, lon, lat) : 0;
    const f = Math.max(0, Math.min(1, effectiveFill() - 0.10 * Math.max(-1, Math.min(1, rel / 3))));
    let t = "<b>" + lat.toFixed(5) + "°N, " + lon.toFixed(5) + "°E</b><br>Elevation " + Math.round(el) + " m";
    if (h.object === buildingsMesh) t += "<br>Building (OpenStreetMap footprint)";
    else { const cl = CELLS.find((k) => Math.abs(k.x - h.point.x) <= HALF / GN + 0.1 && Math.abs(k.z - h.point.z) <= HALF / GN + 0.1); if (cl) t += "<br>Zone R" + (cl.row + 1) + "C" + (cl.col + 1) + ": " + cl.vegHa.toFixed(1) + " ha green of " + cl.cellHa.toFixed(1) + " ha"; }
    if (h.object !== buildingsMesh) t += "<br>Modelled soil water here: " + Math.round(f * CAP) + " mm (" + Math.round(f * 100) + "% of capacity)<br><span style='opacity:.7'>Twin value adjusted by terrain position; not a sensor reading.</span>";
    pop.innerHTML = t; pop.style.display = "block"; pop.style.left = Math.min(r.width - 260, e.clientX - r.left + 12) + "px"; pop.style.top = Math.min(r.height - 110, e.clientY - r.top + 12) + "px";
  }
  function frame(t) {
    requestAnimationFrame(frame); clockT = t / 1000; controls.update();
    if (rain.visible) { const p = rain.geometry.attributes.position; for (let i = 0; i < p.count; i++) { let y = p.getY(i) - 6; if (y < 0) y = 400; p.setY(i, y); } p.needsUpdate = true; rain.position.set(0, Yat(lon0, lat0), 0); }
    if (marker) marker.children[1].scale.setScalar(1 + 0.2 * Math.sin(clockT * 3));
    renderer.render(scene, camera);
  }

  // ------------------------------------------------------------ boot
  async function init() { try { await init2(); } catch (e) { console.error(e); const l = $("place3d-load"); if (l) { l.style.display = "flex"; l.textContent = "Could not build the 3D place: " + e.message; } } }
  async function init2() {
    let d; try { d = await (await fetch("/api/twin-state")).json(); } catch (e) { return; }
    if (!d.ready) return; DATA = d; lat0 = d.farm_lat; lon0 = d.farm_lon; KY = 110574; KX = 111320 * Math.cos(lat0 * D2R);
    $("place3d-name").textContent = d.location_label || d.district || "";
    scene3(); requestAnimationFrame(frame);
    const bb = { lonmin: lon0 - HALF / KX * 1.05, lonmax: lon0 + HALF / KX * 1.05, latmin: lat0 - HALF / KY * 1.05, latmax: lat0 + HALF / KY * 1.05 };
    status("Streaming terrain…");
    ELEV = await loadElevation(bb); if (ELEV) { baseElev = elevAt(lon0, lat0); } else status("Elevation tiles unavailable, terrain drawn flat.");
    SAT = { T: grid(bb, ZS), ok: false }; const T = SAT.T, c = document.createElement("canvas"); c.width = T.nx * TILE; c.height = T.ny * TILE; const g = c.getContext("2d"); g.fillStyle = "#26332d"; g.fillRect(0, 0, c.width, c.height);
    SAT.canvas = c; SAT.tex = tex(c, true); buildTerrain(); setMarker(); applyScenario(); $("place3d-load").style.display = "none";
    status("Streaming satellite imagery…");
    let last = 0; const res = await streamTiles(T, SAT_URL, (img, i, j) => { if (img) g.drawImage(img, i * TILE, j * TILE); const n = performance.now(); if (n - last > 400) { last = n; SAT.tex.needsUpdate = true; } }, (d, t) => status("Streaming satellite imagery " + d + " / " + t));
    SAT.tex.needsUpdate = true; SAT.ok = res.failed < res.total * 0.5; status(SAT.ok ? "Satellite imagery loaded." : "Satellite tiles could not be loaded (network?).");
    buildOverlays(); loadBuildings(); loadDistrictState(); window.__place3dready = true;
    if (SELF_SRC) { const sc = document.createElement("script"); sc.src = SELF_SRC.replace(/place3d\.js(\?.*)?$/, "place3d_sim.js$1"); document.body.appendChild(sc); }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("#place3d-modes button"); if (b) { mode = b.dataset.mode; applyMode(); }
    if (e.target.id === "place3d-bldbtn") { bldOn = !bldOn; e.target.classList.toggle("on", bldOn); if (buildingsMesh) buildingsMesh.visible = bldOn; }
  });
  const rel = $("place3d-relief");
  if (rel) rel.addEventListener("change", (e) => { ex = +e.target.value; $("place3d-relief-val").textContent = ex + "×"; if (terrain) { buildTerrain(); buildBuildings(); setMarker(); } });

  let SATIMG = null;
  function satImage() { if (SATIMG !== null) return SATIMG; try { const c = SAT.canvas; SATIMG = c.getContext("2d").getImageData(0, 0, c.width, c.height); } catch (e) { SATIMG = false; } return SATIMG; }
  function greenAt(lon, lat) {
    const im = SAT && SAT.ok ? satImage() : false; if (!im) return null; const T = SAT.T;
    const x = Math.floor((mx(lon) * T.n - T.x0) * TILE), y = Math.floor((my(lat) * T.n - T.y0) * TILE); if (x < 0 || y < 0 || x >= im.width || y >= im.height) return null;
    const k = (y * im.width + x) * 4, r = im.data[k], g = im.data[k + 1], b = im.data[k + 2], exg = (2 * g - r - b) / (r + g + b + 1), t = Math.max(0, Math.min(1, (exg - 0.02) / 0.08));
    return { veg: t * t * (3 - 2 * t), exg };
  }
  function look(kind) { const k = SCEN[kind] || SCEN.clear; rain.visible = !!k.rain; scene.background.setHex(k.sky); scene.fog.color.setHex(k.sky); amb.intensity = 0.8 - k.dark; sun.intensity = k.sun; sun.color.setHex(k.warm ? 0xffc27a : 0xfff2dc); }
  function ctx() { return { THREE, scene, world, camera, controls, renderer, terrain, DATA, HALF, KX, KY, lon0, lat0, ex, baseElev, toLon, toLat, wx, wz, Yat, elevAt, relAt: (lo, la) => (ELEV ? sampleE(ELEV.rel, lo, la) : 0), greenAt, buildings: bld, SAT, hasDEM: !!ELEV, look, DSTATE, applyBuildingsVisible: (v) => { if (buildingsMesh) buildingsMesh.visible = v; } }; }
  window.PLACE3D = { ctx, setScenario: (name, delta) => { if (!DATA) return; scenario = { name: name || "custom", delta: delta || 0 }; applyScenario(); },
    get ready() { return !!window.__place3dready; }, get buildings() { return bld.length; }, setMode: (m) => { mode = m; applyMode(); } };
  init();
})();