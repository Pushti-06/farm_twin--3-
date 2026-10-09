// ---------------------------------------------------------------------------
// Geographic navigation layer: INDIA -> TAMIL NADU -> CHENNAI -> FARM -> 3D TWIN
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
  const INDIA = [[74.3,37.0],[77.8,35.5],[79.0,34.3],[78.9,32.5],[80.2,30.8],[81.0,30.2],[81.8,30.3],[84.0,28.6],[86.0,27.9],[88.1,27.9],[88.8,27.3],[89.8,26.8],[92.0,26.9],[94.5,27.6],[96.1,28.3],[97.3,28.2],[95.5,26.5],[94.5,25.0],[93.3,23.0],[92.6,21.9],[92.2,24.0],[91.4,23.5],[91.6,24.5],[90.2,25.2],[89.0,26.2],[88.5,25.2],[88.1,24.6],[88.9,22.1],[87.0,21.5],[86.8,20.7],[85.0,19.3],[84.0,18.2],[82.3,16.6],[80.9,15.8],[80.2,13.4],[79.9,11.4],[79.2,10.3],[78.2,8.9],[77.5,8.1],[76.6,8.9],[75.8,11.3],[74.9,12.9],[74.0,15.0],[73.3,17.5],[72.8,19.1],[72.7,21.0],[72.0,21.2],[70.4,20.9],[69.0,22.3],[68.2,23.7],[70.0,24.2],[71.0,24.4],[70.0,25.5],[70.2,27.2],[71.9,27.9],[73.0,29.9],[74.5,31.1],[74.6,32.5],[73.8,34.0]];
  const TAMIL_NADU = [[80.3,13.55],[80.35,13.1],[80.15,12.4],[79.85,11.75],[79.85,10.9],[79.4,10.3],[79.3,9.7],[78.9,9.25],[78.2,8.9],[77.55,8.08],[77.25,8.5],[77.2,9.2],[77.35,9.8],[77.1,10.3],[76.85,10.9],[76.85,11.45],[77.3,11.9],[77.7,12.2],[77.8,12.8],[78.4,13.2],[79.2,13.4],[79.8,13.65]];
  const STATE_LABELS = [
    ["PUNJAB", 75.3, 31.0], ["RAJASTHAN", 73.8, 26.6], ["GUJARAT", 71.4, 22.8],
    ["UTTAR PRADESH", 80.6, 27.0], ["MADHYA PRADESH", 78.0, 23.6], ["BIHAR", 85.7, 25.7],
    ["WEST BENGAL", 87.9, 23.6], ["ODISHA", 84.6, 20.6], ["MAHARASHTRA", 76.0, 19.6],
    ["TELANGANA", 79.0, 17.9], ["ANDHRA PRADESH", 79.8, 15.7], ["KARNATAKA", 75.9, 14.6],
  ];
  // illustrative agricultural-zone nodes inside Tamil Nadu
  const DISTRICTS = [
    { id: "chennai", name: "CHENNAI", lon: 80.27, lat: 13.08 },
    { id: "coimbatore", name: "COIMBATORE", lon: 76.96, lat: 11.02, stress: 0x3ddc84 },
    { id: "trichy", name: "TIRUCHIRAPPALLI", lon: 78.70, lat: 10.80, stress: 0xf0b34a },
    { id: "madurai", name: "MADURAI", lon: 78.12, lat: 9.92, stress: 0xe05a5a },
  ];

  const proj = (lon, lat) => new THREE.Vector3((lon - 80) * 0.92, 0, -(lat - 20));
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const $ = id => document.getElementById(id);

  // ---- state ---------------------------------------------------------------
  let DATA = null;
  let stage = "idle";            // india | tn | chennai | found | init | descend | done
  let overlay, renderer, scene, camera, raf = 0, running = false, busy = false;
  let indiaMesh, tnMesh, tnEdges, indiaEdges, stressGroup, farmGroup, particles;
  let indiaMat, tnMat, stressMats = [];
  const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
  const labels = [];
  const clock = new THREE.Clock();
  let skipFlag = false;

  const VIEWS = {
    india:   { pos: new THREE.Vector3(0, 40, 21),    target: new THREE.Vector3(0, 0, -2.5) },
    tn:      { pos: new THREE.Vector3(-1.1, 9.5, 15.5), target: new THREE.Vector3(-1.1, 0, 8.7) },
    chennai: { pos: new THREE.Vector3(0.25, 2.7, 8.9), target: new THREE.Vector3(0.25, 0, 6.85) },
    farm:    { pos: new THREE.Vector3(0.33, 0.16, 7.25), target: new THREE.Vector3(0.33, 0, 6.9) },
  };
  const FARM_POS = proj(80.27, 13.08).add(new THREE.Vector3(0.08, 0, -0.02));

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
    const names = { india: "INDIA", tn: "TAMIL NADU", chennai: "CHENNAI", found: "FARM", init: "FARM", descend: "FARM" };
    const order = ["india", "tn", "chennai", "found"];
    const idx = Math.max(0, order.indexOf(s === "init" || s === "descend" ? "found" : s));
    const trail = ["INDIA", "TAMIL NADU", "CHENNAI", "FARM"].slice(0, idx + 1);
    $("geo-crumb").innerHTML = trail.map((t, i) => (i === trail.length - 1 ? "<b>" + t + "</b>" : t)).join(" / ");
    $("geo-hud-region").textContent = (s === "chennai" || s === "found" || s === "init" || s === "descend") ? "CHENNAI" : "TAMIL NADU";
    const hints = {
      india: "CLICK TAMIL NADU TO ENTER",
      tn: "SELECT CHENNAI REGION",
      chennai: "SELECT THE GLOWING FARM NODE",
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
      place: (d.location_label || d.state || "—"),
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
      "<span style='opacity:.7'>Illustrative zones. Chennai colour follows the live twin state.</span></div>";
  }
  function chennaiPanel() {
    const s = twinSummary();
    return "<h3>CHENNAI REGION</h3><div class='tag'>AGRICULTURAL ZONE</div>" +
      row("WEATHER", s.temp) + row("RAINFALL", s.rain) + row("CROP", s.crop) + row("TWIN STATUS", "● ACTIVE", "good");
  }
  function indiaPanel() {
    return "<h3>INDIA</h3><div class='tag'>NATIONAL AGRICULTURAL DIGITAL TWIN</div>" + row("ACTIVE REGION", "TAMIL NADU", "good") + row("COVERAGE", "STATE-LEVEL");
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

    // India
    indiaMat = new THREE.MeshStandardMaterial({ color: 0x0d2a31, roughness: 0.9, metalness: 0.1, transparent: true, opacity: 1 });
    const ig = extrude(INDIA, 0.14);
    indiaMesh = new THREE.Mesh(ig, indiaMat); scene.add(indiaMesh);
    indiaEdges = new THREE.LineSegments(new THREE.EdgesGeometry(ig, 30), new THREE.LineBasicMaterial({ color: 0x3aa6b6, transparent: true, opacity: 0.75 }));
    scene.add(indiaEdges);

    // Tamil Nadu (raised + glowing)
    tnMat = new THREE.MeshStandardMaterial({ color: 0x14614a, emissive: 0x1fbf75, emissiveIntensity: 0.4, roughness: 0.6, transparent: true, opacity: 1 });
    const tg = extrude(TAMIL_NADU, 0.4);
    tg.translate(0, 0.0, 0);
    tnMesh = new THREE.Mesh(tg, tnMat); scene.add(tnMesh);
    tnEdges = new THREE.LineSegments(new THREE.EdgesGeometry(tg, 30), new THREE.LineBasicMaterial({ color: 0x7ff0b4, transparent: true, opacity: 0.95 }));
    scene.add(tnEdges);

    // stress zones (only visible in TN stage)
    stressGroup = new THREE.Group(); stressGroup.visible = false; scene.add(stressGroup);
    const t = DATA.twin_state || {};
    const chennaiColor = t.status === "Healthy" ? 0x3ddc84 : (t.drought_risk && t.heat_stress) ? 0xe05a5a : 0xf0b34a;
    DISTRICTS.forEach(d => {
      const col = d.id === "chennai" ? chennaiColor : d.stress;
      const m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(d.id === "chennai" ? 0.55 : 0.75, 40), m);
      disc.rotation.x = -Math.PI / 2;
      const p = proj(d.lon, d.lat); disc.position.set(p.x, 0.43, p.z);
      stressGroup.add(disc); stressMats.push(m);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 24), new THREE.MeshBasicMaterial({ color: 0xeaf7f9, transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.45, p.z); stressGroup.add(ring);
    });

    // farm nodes around Chennai
    farmGroup = new THREE.Group(); farmGroup.visible = false; scene.add(farmGroup);
    const cp = proj(80.27, 13.08);
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
    STATE_LABELS.forEach(s => addLabel(s[0], proj(s[1], s[2]).setY(0.2), ["india"], "dim"));
    addLabel("TAMIL NADU", proj(78.2, 11.1).setY(0.6), ["india"], "target", () => { if (stage === "india") goTN(); });
    DISTRICTS.forEach(d => {
      const isC = d.id === "chennai";
      addLabel(d.name, proj(d.lon, d.lat).setY(0.9), ["tn"], isC ? "target" : "", isC
        ? () => { if (stage === "tn") goChennai(); }
        : () => toast("DEMO TWIN IS BOUND TO THE CHENNAI REGION"));
    });
    addLabel("FARM-01 · LIVE TWIN", FARM_POS.clone().setY(0.8), ["chennai"], "target", () => { if (stage === "chennai") goFarm(); });
    nodesLabels();
    function nodesLabels() {
      farmGroup.children.forEach(g => { if (!g.userData.main) addLabel("UNBOUND ZONE", g.position.clone().setY(0.6), ["chennai"], "dim"); });
    }

    camPos.copy(VIEWS.india.pos); camTarget.copy(VIEWS.india.target);
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

    const sway = (stage === "india") ? Math.sin(t * 0.35) * 1.4 : (stage === "tn" ? Math.sin(t * 0.35) * 0.25 : 0);
    camera.position.set(camPos.x + sway, camPos.y, camPos.z);
    camera.lookAt(camTarget);
    renderer.render(scene, camera);

    // labels
    const w = window.innerWidth, h = window.innerHeight;
    labels.forEach(l => {
      const on = l.states.indexOf(stage) !== -1;
      l.el.classList.toggle("on", on);
      if (!on) return;
      tmpV.copy(l.vec).project(camera);
      if (tmpV.z > 1) { l.el.style.visibility = "hidden"; return; }
      l.el.style.visibility = "visible";
      l.el.style.left = ((tmpV.x * 0.5 + 0.5) * w) + "px";
      l.el.style.top = ((-tmpV.y * 0.5 + 0.5) * h) + "px";
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
  async function goTN() {
    if (busy) return; busy = true;
    stage = "tn"; setStage("tn");
    stressGroup.visible = true;
    showPanel(tnPanel());
    await flyTo(VIEWS.tn, 1400, e => {
      indiaMat.opacity = 1 - 0.65 * e;
      indiaEdges.material.opacity = 0.75 - 0.5 * e;
      stressMats.forEach(m => (m.opacity = 0.5 * e));
    });
    busy = false;
  }
  async function goChennai() {
    if (busy) return; busy = true;
    stage = "chennai"; setStage("chennai");
    farmGroup.visible = true;
    showPanel(chennaiPanel());
    await flyTo(VIEWS.chennai, 1500, e => {
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
      '<div class="crumb">INDIA / TAMIL NADU / CHENNAI / <b>FARM</b></div>' +
      "<h4>FARM DIGITAL TWIN</h4>" +
      '<div class="loc">' + s.place.toUpperCase() + "</div>" +
      '<div class="src ' + (s.orion ? "tone-good" : "tone-warn") + '">' + (s.orion ? "● LIVE · FIWARE ORION" : "○ LOCAL FALLBACK") + "</div>" +
      kv("SOIL WATER", s.water) + kv("DROUGHT RISK", s.drought, s.droughtTone) + kv("HEAT STRESS", s.heat, s.heatTone) +
      kv("DRY DAYS", s.dry) + kv("PREDICTED YIELD", s.yieldT);
    requestAnimationFrame(() => hud.classList.add("on"));
    function kv(k, v, tone) { return '<div class="kv"><span>' + k + "</span><span" + (tone ? ' class="tone-' + tone + '"' : "") + ">" + v + "</span></div>"; }
  }

  // ---- interaction ---------------------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function onCanvasMove(ev) {
    if (stage !== "india") { $("geo-canvas").style.cursor = "default"; return; }
    ndc.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    $("geo-canvas").style.cursor = ray.intersectObject(tnMesh).length ? "pointer" : "default";
  }
  function onCanvasClick(ev) {
    if (stage !== "india") return;
    ndc.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.intersectObject(tnMesh).length) goTN();
    else if (ray.intersectObject(indiaMesh).length) toast("ACTIVE TWIN REGION: TAMIL NADU");
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
    overlay = document.createElement("div");
    overlay.id = "geo-overlay";
    overlay.innerHTML =
      '<canvas id="geo-canvas"></canvas><div id="geo-vignette"></div><div id="geo-labels"></div>' +
      '<div id="geo-hud" class="geo-glass"><div class="brand">AGRI-TWIN</div><div class="sub">NATIONAL AGRICULTURAL DIGITAL TWIN</div>' +
      '<div class="region-label">ACTIVE REGION</div><div class="region" id="geo-hud-region">TAMIL NADU</div>' +
      '<div class="dots geo-mono"><div>LIVE WEATHER<span class="dot" id="dot-weather"></span></div><div>ML MODEL<span class="dot" id="dot-ml"></span></div><div>ORION<span class="dot" id="dot-orion"></span></div></div></div>' +
      '<div id="geo-crumb" class="geo-glass geo-mono"></div>' +
      '<div id="geo-panel" class="geo-glass"></div>' +
      '<div id="geo-found" class="geo-glass"></div><div id="geo-init" class="geo-glass geo-mono"></div>' +
      '<div id="geo-hint" class="geo-glass geo-mono"></div><div id="geo-toast" class="geo-glass geo-mono"></div>' +
      '<button id="geo-skip">SKIP INTRO ›</button>';
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    const d = DATA;
    $("dot-weather").className = "dot " + (d.current_weather ? "ok" : "off");
    $("dot-ml").className = "dot " + (d.recommendation && d.recommendation.predicted_yield_kg_per_ha != null ? "ok" : "off");
    $("dot-orion").className = "dot " + (d.fiware_source === "orion" ? "ok" : "warn");
    $("geo-skip").addEventListener("click", skip);
    $("geo-canvas").addEventListener("click", onCanvasClick);
    $("geo-canvas").addEventListener("mousemove", onCanvasMove);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && stage !== "done") skip(); });

    buildScene();
    setStage("india");
    showPanel(indiaPanel());
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