// ---------------------------------------------------------------------------
// Geographic navigation layer: TAMIL NADU -> DISTRICT -> FARM -> 3D TWIN
//
// Purely a visual/spatial layer on top of the existing twin page. It reads the
// same /api/twin-state the page already uses and never writes to the backend.
// Map outlines are simplified hand-built polygons (not survey-grade GIS) --
// the farm data shown at the end is the real computed twin state.
// ---------------------------------------------------------------------------
(function () {
  "use strict";
  if (typeof THREE === "undefined") return;

  // ---- simplified geography (lon, lat) -------------------------------------
  const TAMIL_NADU = [[80.3,13.55],[80.35,13.1],[80.15,12.4],[79.85,11.75],[79.85,10.9],[79.4,10.3],[79.3,9.7],[78.9,9.25],[78.2,8.9],[77.55,8.08],[77.25,8.5],[77.2,9.2],[77.35,9.8],[77.1,10.3],[76.85,10.9],[76.85,11.45],[77.3,11.9],[77.7,12.2],[77.8,12.8],[78.4,13.2],[79.2,13.4],[79.8,13.65]];
  // every Tamil Nadu district (name + headquarters), supplied by /api/twin-state
  let DISTRICTS = [];
  let ALERTS = {};                // district id -> {level, satellite_status} from /api/tn/districts (observed twin)
  let farmD = null;               // the district the farm twin lives in

  const proj = (lon, lat) => new THREE.Vector3((lon - 80) * 0.92, 0, -(lat - 20));
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const $ = id => document.getElementById(id);

  // ---- state ---------------------------------------------------------------
  let DATA = null;
  let stage = "idle";            // tn | district | found | init | descend | done
  let overlay, renderer, scene, camera, raf = 0, running = false, busy = false;
  let tnMesh, tnEdges, stressGroup, farmGroup, particles;
  let tnMat, stressMats = [];
  const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
  const labels = [];
  const clock = new THREE.Clock();
  let skipFlag = false;

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const VIEWS = {
    tn: { pos: V(-0.55, 7.1, 13.7), target: V(-0.55, 0, 8.8) },
    district: null,   // set per farm district in setFarmDistrict()
    farm: null,
  };
  const FARM_POS = new THREE.Vector3();
  const districtName = () => (farmD ? farmD.name.toUpperCase() : "DISTRICT");

  // Frame the camera on whichever district holds the farm.
  function setFarmDistrict() {
    farmD = DISTRICTS.find(d => d.id === DATA.district) || DISTRICTS.find(d => d.id === "CHENNAI") || DISTRICTS[0];
    const cp = proj(farmD.lon, farmD.lat);
    VIEWS.district = { pos: cp.clone().add(V(0, 2.7, 1.98)), target: cp.clone().add(V(0, 0, -0.07)) };
    VIEWS.farm = { pos: cp.clone().add(V(0.08, 0.16, 0.33)), target: cp.clone().add(V(0.08, 0, -0.02)) };
    FARM_POS.copy(cp).add(V(0.08, 0, -0.02));
  }

  // ---- helpers -------------------------------------------------------------
  function shapeFrom(pts) {
    const s = new THREE.Shape();
    pts.forEach((p, i) => {
      const v = proj(p[0], p[1]);
      // shape plane (x, y) -> after rotateX(-90deg): world (x, ., -y); we want world z = v.z => y = -v.z
      if (i === 0) s.moveTo(v.x, -v.z); else s.lineTo(v.x, -v.z);
    });
    s.closePath();
    return s;
  }
  function extrude(pts, depth) {
    const g = new THREE.ExtrudeGeometry(shapeFrom(pts), { depth, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return g;
  }
  function addLabel(text, vec, states, cls, onClick) {
    const el = document.createElement("div");
    el.className = "geo-label" + (cls ? " " + cls : "");
    el.textContent = text;
    if (onClick) el.addEventListener("click", onClick);
    $("geo-labels").appendChild(el);
    labels.push({ el, vec, states });
    return el;
  }
  function toast(msg) {
    const t = $("geo-toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove("on"), 2200);
  }
  function setStage(s) {
    stage = s;
    const order = ["tn", "district", "found"];
    const idx = Math.max(0, order.indexOf(s === "init" || s === "descend" ? "found" : s));
    const trail = ["TAMIL NADU", districtName(), "FARM"].slice(0, idx + 1);
    $("geo-crumb").innerHTML = trail.map((t, i) => (i === trail.length - 1 ? "<b>" + t + "</b>" : t)).join(" / ");
    $("geo-hud-region").textContent = (s === "district" || s === "found" || s === "init" || s === "descend") ? districtName() : "TAMIL NADU";
    const hints = {
      tn: "SELECT " + districtName() + " DISTRICT",
      district: "SELECT THE GLOWING FARM NODE",
    };
    const h = $("geo-hint");
    h.style.display = hints[s] ? "block" : "none";
    if (hints[s]) h.textContent = hints[s];
  }

  // ---- data helpers --------------------------------------------------------
  function twinSummary() {
    const d = DATA, t = d.twin_state || {}, w = d.current_weather || {};
    const drought = !!t.drought_risk, heat = !!t.heat_stress;
    const kg = d.recommendation && d.recommendation.predicted_yield_kg_per_ha;
    return {
      temp: w.temperature != null ? Math.round(w.temperature) + "°C" : "—",
      rain: w.precipitation != null ? (w.precipitation > 0.05 ? w.precipitation + " mm" : "NONE") : "—",
      crop: (d.crop || "—").toUpperCase(),
      status: (t.status || "—").toUpperCase(),
      statusTone: t.status === "Healthy" ? "good" : (drought && heat) ? "bad" : "warn",
      drought: drought ? "HIGH" : "LOW", droughtTone: drought ? "bad" : "good",
      heat: heat ? "ACTIVE" : "NONE", heatTone: heat ? "bad" : "good",
      water: t.soil_water_mm != null ? t.soil_water_mm + " mm" : "—",
      dry: t.consecutive_dry_days != null ? t.consecutive_dry_days : "—",
      yieldT: kg != null ? (kg / 1000).toFixed(2) + " t/ha" : "—",
      area: d.area != null ? d.area + " ha" : "—",
      coords: d.farm_lat != null ? d.farm_lat.toFixed(4) + ", " + d.farm_lon.toFixed(4) : "—",
      place: (d.location_label || d.district || "—"),
      orion: d.fiware_source === "orion",
    };
  }
  const row = (k, v, tone) => '<div class="row"><span>' + k + "</span><span" + (tone ? ' class="tone-' + tone + '"' : "") + ">" + v + "</span></div>";

  function showPanel(html) {
    const p = $("geo-panel");
    p.classList.remove("on");
    setTimeout(() => { p.innerHTML = html; p.classList.add("on"); }, 220);
  }
  function tnPanel() {
    const s = twinSummary();
    return "<h3>TAMIL NADU</h3><div class='tag'>AGRICULTURAL DIGITAL TWIN</div>" +
      row("LIVE WEATHER", s.temp) + row("CROP", s.crop) + row("WATER STATUS", s.status, s.statusTone) + row("DROUGHT RISK", s.drought, s.droughtTone) +
      "<div id='geo-legend'><div class='geo-mono' style='color:#9fd8e2'>MODELLED AGRICULTURAL STRESS</div>" +
      "<i style='background:#3ddc84'></i>LOWER<br><i style='background:#f0b34a'></i>MODERATE<br><i style='background:#e05a5a'></i>HIGH<br>" +
      "<span style='opacity:.7'>Only " + districtName() + " carries a live twin state; other districts are unbound.</span></div>";
  }
  function districtPanel() {
    const s = twinSummary();
    return "<h3>" + districtName() + " DISTRICT</h3><div class='tag'>AGRICULTURAL ZONE</div>" +
      row("WEATHER", s.temp) + row("RAINFALL", s.rain) + row("CROP", s.crop) + row("TWIN STATUS", "● ACTIVE", "good");
  }

  // ---- scene ---------------------------------------------------------------
  function buildScene() {
    const canvas = $("geo-canvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x04080b, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x04080b, 30, 75);
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.02, 200);

    scene.add(new THREE.AmbientLight(0x6fa8b4, 0.55));
    const dl = new THREE.DirectionalLight(0xbfeaf1, 0.9);
    dl.position.set(-8, 20, 14); scene.add(dl);

    const grid = new THREE.GridHelper(90, 90, 0x0f4a52, 0x0a2227);
    grid.position.y = -0.06; grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);

    // Tamil Nadu (raised + glowing)
    tnMat = new THREE.MeshStandardMaterial({ color: 0x14614a, emissive: 0x1fbf75, emissiveIntensity: 0.4, roughness: 0.6, transparent: true, opacity: 1 });
    const tg = extrude(TAMIL_NADU, 0.4);
    tg.translate(0, 0.0, 0);
    tnMesh = new THREE.Mesh(tg, tnMat); scene.add(tnMesh);
    tnEdges = new THREE.LineSegments(new THREE.EdgesGeometry(tg, 30), new THREE.LineBasicMaterial({ color: 0x7ff0b4, transparent: true, opacity: 0.95 }));
    scene.add(tnEdges);

    // stress zones (only visible in TN stage)
    stressGroup = new THREE.Group(); stressGroup.visible = true; scene.add(stressGroup);
    const t = DATA.twin_state || {};
    const farmColor = t.status === "Healthy" ? 0x3ddc84 : (t.drought_risk && t.heat_stress) ? 0xe05a5a : 0xf0b34a;
    DISTRICTS.forEach(d => {
      const p = proj(d.lon, d.lat);
      if (d === farmD) {   // only the farm's district has a live twin state to colour by
        const m = new THREE.MeshBasicMaterial({ color: farmColor, transparent: true, opacity: 0.5, depthWrite: false });
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.4, 40), m);
        disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, 0.43, p.z);
        stressGroup.add(disc); stressMats.push(m);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 24), new THREE.MeshBasicMaterial({ color: 0xeaf7f9, transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.45, p.z); stressGroup.add(ring);
      // alert beacon: only districts whose OBSERVED twin currently has an alert get one (colour = level)
      const al = ALERTS[d.id];
      if (al && al.level && al.level !== "none" && al.level !== "unknown") {
        const bc = { watch: 0xf0b34a, warning: 0xff8a3d, critical: 0xe05a5a }[al.level] || 0xf0b34a;
        const bm = new THREE.MeshBasicMaterial({ color: bc, transparent: true, opacity: 0.85, depthWrite: false });
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), bm);
        beam.position.set(p.x, 0.9, p.z); stressGroup.add(beam); stressMats.push(bm);
      }
    });

    // farm nodes around the farm district
    farmGroup = new THREE.Group(); farmGroup.visible = false; scene.add(farmGroup);
    const cp = proj(farmD.lon, farmD.lat);
    const nodes = [
      { off: [0.08, -0.02], main: true },
      { off: [-0.38, 0.2] }, { off: [0.42, 0.26] }, { off: [-0.12, -0.42] }, { off: [0.5, -0.28] },
    ];
    nodes.forEach(n => {
      const x = cp.x + n.off[0], z = cp.z + n.off[1];
      const col = n.main ? 0x7ff0b4 : 0x3a7a86;
      const g = new THREE.Group(); g.position.set(x, 0.43, z);
      const sz = n.main ? 0.17 : 0.12;
      const sq = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-sz, 0, -sz), new THREE.Vector3(sz, 0, -sz), new THREE.Vector3(sz, 0, sz), new THREE.Vector3(-sz, 0, sz)]),
        new THREE.LineBasicMaterial({ color: col }));
      g.add(sq);
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(sz * 2, sz * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: n.main ? 0.35 : 0.14, depthWrite: false }));
      g.add(fill);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, n.main ? 0.55 : 0.3, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: n.main ? 0.9 : 0.4 }));
      beam.position.y = n.main ? 0.28 : 0.15; g.add(beam);
      if (n.main) { g.userData.main = true; g.userData.fill = fill; g.userData.beam = beam; farmGroup.userData.main = g; }
      farmGroup.add(g);
    });
    // anchor farm label to the main node
    const mp = farmGroup.userData.main.position;
    FARM_POS.set(mp.x, 0.43, mp.z);

    // drifting particles
    const N = 450, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 50; pos[i * 3 + 1] = Math.random() * 8; pos[i * 3 + 2] = (Math.random() - 0.5) * 45 - 2; }
    const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fdcea, size: 0.07, transparent: true, opacity: 0.45, depthWrite: false }));
    scene.add(particles);

    // labels
    DISTRICTS.forEach(d => {
      const isF = d === farmD;
      addLabel(d.name.toUpperCase(), proj(d.lon, d.lat).setY(0.45), ["tn"], isF ? "target" : "dim", isF
        ? () => { if (stage === "tn") goDistrict(); }
        : () => { const a = ALERTS[d.id]; toast(a && a.level !== "unknown" ? d.name.toUpperCase() + " · ALERT: " + a.level.toUpperCase() + " · " + String(a.satellite_status).toUpperCase() : "NO OBSERVED DATA YET FOR " + d.name.toUpperCase()); });
    });
    addLabel("FARM-01 · LIVE TWIN", FARM_POS.clone().setY(0.8), ["district"], "target", () => { if (stage === "district") goFarm(); });
    nodesLabels();
    function nodesLabels() {
      farmGroup.children.forEach(g => { if (!g.userData.main) addLabel("UNBOUND ZONE", g.position.clone().setY(0.6), ["district"], "dim"); });
    }

    camPos.copy(VIEWS.tn.pos); camTarget.copy(VIEWS.tn.target);
  }

  // ---- render loop ---------------------------------------------------------
  const tmpV = new THREE.Vector3();
  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();

    tnMat.emissiveIntensity = 0.38 + 0.22 * Math.sin(t * 2.0);
    tnEdges.material.opacity = 0.8 + 0.2 * Math.sin(t * 2.0);
    if (farmGroup.visible && farmGroup.userData.main) {
      const m = farmGroup.userData.main;
      m.userData.fill.material.opacity = 0.3 + 0.25 * Math.sin(t * 3);
      m.userData.beam.material.opacity = 0.65 + 0.3 * Math.sin(t * 3);
    }
    const arr = particles.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) { arr[i + 1] += 0.008; if (arr[i + 1] > 8) arr[i + 1] = 0; }
    particles.geometry.attributes.position.needsUpdate = true;

    const sway = stage === "tn" ? Math.sin(t * 0.35) * 0.25 : 0;
    camera.position.set(camPos.x + sway, camPos.y, camPos.z);
    camera.lookAt(camTarget);
    renderer.render(scene, camera);

    // labels
    const w = window.innerWidth, h = window.innerHeight;
    const placed = [];   // screen rects already taken by labels
    const hit = (r) => placed.some(q => r.l < q.r + 3 && r.r > q.l - 3 && r.t < q.b + 2 && r.b > q.t - 2);
    // important labels (the farm's) claim their space first, then the dim district names
    const active = labels.filter(l => l.states.indexOf(stage) !== -1);
    labels.forEach(l => l.el.classList.toggle("on", active.indexOf(l) !== -1));
    active.sort((a, b) => (a.el.classList.contains("dim") ? 1 : 0) - (b.el.classList.contains("dim") ? 1 : 0));
    active.forEach(l => {
      tmpV.copy(l.vec).project(camera);
      if (tmpV.z > 1) { l.el.style.visibility = "hidden"; return; }
      const x = (tmpV.x * 0.5 + 0.5) * w, y = (-tmpV.y * 0.5 + 0.5) * h;
      const lw = l.el.offsetWidth, lh = l.el.offsetHeight || 14;
      let side = "";
      let rect = { l: x - lw / 2, r: x + lw / 2, t: y - lh / 2, b: y + lh / 2 };
      if (l.el.classList.contains("dim") && stage === "tn") {
        // district names sit beside their marker: right, left, then above/below, else hidden
        const cands = [
          ["right", { l: x + 9, r: x + 9 + lw, t: y - lh / 2, b: y + lh / 2 }],
          ["left", { l: x - 9 - lw, r: x - 9, t: y - lh / 2, b: y + lh / 2 }],
          ["above", { l: x - lw / 2, r: x + lw / 2, t: y - 10 - lh, b: y - 10 }],
          ["below", { l: x - lw / 2, r: x + lw / 2, t: y + 10, b: y + 10 + lh }],
        ];
        const pick = cands.find(c => !hit(c[1]) && c[1].l > 8 && c[1].r < w - 8);
        if (!pick) { l.el.style.visibility = "hidden"; return; }
        side = pick[0]; rect = pick[1];
      }
      placed.push(rect);
      l.el.dataset.side = side;
      l.el.style.visibility = "visible";
      l.el.style.left = (side === "right" ? x + 9 : side === "left" ? x - 9 : x) + "px";
      l.el.style.top = (side === "above" ? y - 10 - lh / 2 : side === "below" ? y + 10 + lh / 2 : y) + "px";
    });
  }
  function startLoop() { if (!running) { running = true; clock.start(); frame(); } }
  function stopLoop() { running = false; cancelAnimationFrame(raf); }

  // ---- tweening ------------------------------------------------------------
  function flyTo(view, ms, onProgress) {
    return new Promise(resolve => {
      const p0 = camPos.clone(), t0 = camTarget.clone(), start = performance.now();
      (function step(now) {
        const k = Math.min(1, (now - start) / ms), e = easeInOutCubic(k);
        camPos.lerpVectors(p0, view.pos, e); camTarget.lerpVectors(t0, view.target, e);
        if (onProgress) onProgress(e);
        if (k < 1) requestAnimationFrame(step); else resolve();
      })(start);
    });
  }
  function tween(ms, fn) {
    return new Promise(resolve => {
      const start = performance.now();
      (function step(now) { const k = Math.min(1, (now - start) / ms); fn(easeInOutCubic(k)); if (k < 1) requestAnimationFrame(step); else resolve(); })(start);
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- navigation steps ----------------------------------------------------
  async function goDistrict() {
    if (busy) return; busy = true;
    stage = "district"; setStage("district");
    farmGroup.visible = true;
    showPanel(districtPanel());
    await flyTo(VIEWS.district, 1500, e => {
      tnMat.opacity = 1 - 0.55 * e;
      stressMats.forEach(m => (m.opacity = 0.5 - 0.5 * e));
    });
    stressGroup.visible = false;
    busy = false;
  }
  async function goFarm() {
    if (busy) return; busy = true;
    const s = twinSummary();
    stage = "found"; setStage("found");
    $("geo-panel").classList.remove("on");
    $("geo-found").innerHTML = "<h3>FARM TWIN FOUND</h3>" +
      '<div class="row"><span>CROP</span><span>' + s.crop + "</span></div>" +
      '<div class="row"><span>AREA</span><span>' + s.area + "</span></div>" +
      '<div class="row"><span>LOCATION</span><span class="geo-mono">' + s.coords + "</span></div>" +
      '<div class="sync">SYNCING ENVIRONMENT...</div>';
    $("geo-found").classList.add("on");
    await sleep(1300);
    $("geo-found").classList.remove("on");

    // initialization sequence
    stage = "init"; setStage("init");
    const steps = ["LOCATION RESOLVED", "WEATHER SYNCHRONIZED", "CROP MODEL LOADED", "TWIN STATE COMPUTED", s.orion ? "ORION STATE CHECKED" : "ORION STATE CHECKED (LOCAL FALLBACK)"];
    const box = $("geo-init");
    box.innerHTML = "<h3>INITIALIZING FARM TWIN</h3>" + steps.map(x => '<div class="step">' + x + "</div>").join("") +
      '<div class="bar"><i></i></div><div class="online">DIGITAL TWIN ONLINE</div>';
    box.classList.add("on");
    skipFlag = false;
    const stepEls = box.querySelectorAll(".step"), bar = box.querySelector(".bar i");
    for (let i = 0; i < stepEls.length; i++) {
      if (!skipFlag) await sleep(340);
      stepEls[i].classList.add("done");
      bar.style.width = ((i + 1) / stepEls.length * 100) + "%";
    }
    box.querySelector(".online").classList.add("on");
    if (!skipFlag) await sleep(550);
    box.classList.remove("on");
    await descend();
  }

  // The "wow" moment: dive from the map into the existing Three.js farm.
  async function descend() {
    stage = "descend"; setStage("descend");
    $("geo-hint").style.display = "none";
    const wrap = $("twin-3d-wrap");
    const ready = () => typeof twinCamera !== "undefined" && twinCamera && typeof twinControls !== "undefined" && twinControls;
    for (let i = 0; i < 40 && !ready(); i++) await sleep(100);

    // prepare the existing farm camera: start at satellite height directly above the farm,
    // then descend to the full-farm aerial view (the landscape sets that as its default framing)
    let endPos = null, endTarget = null, startPos = null, savedMax = null, savedMin = null;
    if (ready()) {
      endPos = twinCamera.position.clone(); endTarget = twinControls.target.clone();
      const L = window.Landscape && window.Landscape.current;
      if (L) {
        startPos = endTarget.clone().add(new THREE.Vector3(L.span * 0.35, L.span * 3.3, L.span * 0.9));
      } else {
        const dir = endPos.clone().sub(endTarget);
        startPos = endTarget.clone().add(dir.clone().multiplyScalar(3.3)).add(new THREE.Vector3(0, dir.length() * 1.6, 0));
      }
      savedMax = twinControls.maxDistance; savedMin = twinControls.minDistance;
      twinControls.enabled = false; twinControls.maxDistance = 1e5; twinControls.minDistance = 0;
      twinCamera.position.copy(startPos); twinCamera.lookAt(endTarget);
    }

    // scroll the real farm into view behind the overlay
    document.body.style.overflow = "";
    if (wrap) wrap.scrollIntoView({ block: "center", behavior: "auto" });

    let faded = false;
    await flyTo(VIEWS.farm, 1700, e => {
      tnMat.opacity = 0.45 * (1 - e);
      farmGroup.children.forEach(g => g.scale.setScalar(1 + e * 0.6));
      if (e > 0.62 && !faded) { faded = true; overlay.classList.add("fading"); }
    });
    // glide the existing 3D farm camera down into its normal framing
    if (ready() && endPos) {
      const p0 = startPos.clone();
      await tween(window.Landscape && window.Landscape.current ? 3200 : 1900, e => { twinCamera.position.lerpVectors(p0, endPos, e); twinCamera.lookAt(endTarget); });
      twinControls.maxDistance = savedMax; twinControls.minDistance = savedMin;
      twinControls.enabled = true; twinControls.target.copy(endTarget); twinControls.update();
    }
    finish();
  }

  function finish() {
    stage = "done"; busy = false;
    stopLoop();
    overlay.style.display = "none";
    document.body.style.overflow = "";
    showFarmHud();
  }

  function showFarmHud() {
    const wrap = $("twin-3d-wrap"); if (!wrap) return;
    let hud = $("farm-hud");
    if (!hud) { hud = document.createElement("div"); hud.id = "farm-hud"; hud.className = "geo-glass"; wrap.appendChild(hud); }
    const s = twinSummary();
    hud.innerHTML =
      '<div class="crumb">TAMIL NADU / ' + districtName() + ' / <b>FARM</b></div>' +
      "<h4>FARM DIGITAL TWIN</h4>" +
      '<div class="loc">' + s.place.toUpperCase() + "</div>" +
      '<div class="src ' + (s.orion ? "tone-good" : "tone-warn") + '">' + (s.orion ? "● LIVE · FIWARE ORION" : "○ LOCAL FALLBACK") + "</div>" +
      kv("SOIL WATER", s.water) + kv("DROUGHT RISK", s.drought, s.droughtTone) + kv("HEAT STRESS", s.heat, s.heatTone) +
      kv("DRY DAYS", s.dry) + kv("PREDICTED YIELD", s.yieldT);
    requestAnimationFrame(() => hud.classList.add("on"));
    function kv(k, v, tone) { return '<div class="kv"><span>' + k + "</span><span" + (tone ? ' class="tone-' + tone + '"' : "") + ">" + v + "</span></div>"; }
  }

  // ---- interaction ---------------------------------------------------------
  // Hovering a marker names its district, so districts whose label was hidden for
  // lack of room can still be identified.
  const hoverV = new THREE.Vector3();
  function onCanvasMove(ev) {
    const tip = $("geo-hover");
    if (stage !== "tn") { tip.style.display = "none"; return; }
    const w = window.innerWidth, h = window.innerHeight;
    let best = null, bestD = 18;
    DISTRICTS.forEach(d => {
      hoverV.copy(proj(d.lon, d.lat)).setY(0.45).project(camera);
      const dist = Math.hypot((hoverV.x * 0.5 + 0.5) * w - ev.clientX, (-hoverV.y * 0.5 + 0.5) * h - ev.clientY);
      if (dist < bestD) { bestD = dist; best = d; }
    });
    if (!best) { tip.style.display = "none"; return; }
    tip.textContent = best.name.toUpperCase();
    tip.style.left = (ev.clientX + 14) + "px"; tip.style.top = (ev.clientY - 8) + "px";
    tip.style.display = "block";
  }
  function onResize() {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  }
  function skip() {
    if (stage === "init") { skipFlag = true; return; }
    if (stage === "descend" || stage === "done") return;
    // jump straight to the farm view from anywhere else
    overlay.classList.add("fading");
    setTimeout(() => { if (stage !== "done") { finishQuick(); } }, 600);
  }
  function finishQuick() {
    stage = "done"; busy = false; stopLoop(); overlay.style.display = "none"; document.body.style.overflow = ""; showFarmHud();
  }

  // ---- mount ---------------------------------------------------------------
  function mount() {
    DISTRICTS = DATA.districts || [];
    if (!DISTRICTS.length) throw new Error("no district list from /api/twin-state");
    setFarmDistrict();
    overlay = document.createElement("div");
    overlay.id = "geo-overlay";
    overlay.innerHTML =
      '<canvas id="geo-canvas"></canvas><div id="geo-vignette"></div><div id="geo-labels"></div>' +
      '<div id="geo-hud" class="geo-glass"><div class="brand">AGRI-TWIN</div><div class="sub">TAMIL NADU AGRICULTURAL DIGITAL TWIN</div>' +
      '<div class="region-label">ACTIVE REGION</div><div class="region" id="geo-hud-region">TAMIL NADU</div>' +
      '<div class="dots geo-mono"><div>LIVE WEATHER<span class="dot" id="dot-weather"></span></div><div>ML MODEL<span class="dot" id="dot-ml"></span></div><div>ORION<span class="dot" id="dot-orion"></span></div></div></div>' +
      '<div id="geo-crumb" class="geo-glass geo-mono"></div>' +
      '<div id="geo-panel" class="geo-glass"></div>' +
      '<div id="geo-found" class="geo-glass"></div><div id="geo-init" class="geo-glass geo-mono"></div>' +
      '<div id="geo-hint" class="geo-glass geo-mono"></div><div id="geo-toast" class="geo-glass geo-mono"></div><div id="geo-hover" class="geo-mono"></div>' +
      '<button id="geo-skip">SKIP INTRO ›</button>';
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const d = DATA;
    $("dot-weather").className = "dot " + (d.current_weather ? "ok" : "off");
    $("dot-ml").className = "dot " + (d.recommendation && d.recommendation.predicted_yield_kg_per_ha != null ? "ok" : "off");
    $("dot-orion").className = "dot " + (d.fiware_source === "orion" ? "ok" : "warn");
    $("geo-skip").addEventListener("click", skip);
    $("geo-canvas").addEventListener("mousemove", onCanvasMove);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && stage !== "done") skip(); });

    buildScene();
    setStage("tn");
    showPanel(tnPanel());
    startLoop();
  }

  async function start() {
    stage = "idle"; busy = false;
    const old = $("geo-overlay"); if (old) old.remove();
    const oldHud = $("farm-hud"); if (oldHud) oldHud.remove();
    labels.length = 0; stressMats = [];
    if (renderer) { renderer.dispose(); renderer = null; }
    try {
      const res = await fetch("/api/twin-state");
      DATA = await res.json();
    } catch (e) { return; }
    if (!DATA || !DATA.ready) return;      // no farm profile yet: leave the page as it was
    try {
      const ar = await (await fetch("/api/tn/districts")).json();
      ALERTS = {}; (ar.districts || []).forEach(x => { ALERTS[x.district] = x; });
    } catch (e) { ALERTS = {}; }
    try { mount(); } catch (err) { console.error("Geo intro failed, showing farm directly:", err); if (overlay) overlay.remove(); document.body.style.overflow = ""; }
  }

  // replay button
  function addReplayButton() {
    const sub = document.querySelector(".subtitle");
    if (!sub || $("geo-replay")) return;
    const b = document.createElement("button");
    b.id = "geo-replay"; b.textContent = "▶ Replay geographic intro";
    b.addEventListener("click", () => { window.scrollTo(0, 0); start(); });
    sub.insertAdjacentElement("afterend", b);
  }

  addReplayButton();
  start();
})();