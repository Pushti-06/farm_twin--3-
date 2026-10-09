// ---------------------------------------------------------------------------
// Landscape: replaces the old "grid of plants" with a real agricultural
// landscape -- area-scaled farm, instanced crop rows, several field plots,
// terrain, irrigation, roads, fencing, trees and a surrounding countryside.
//
// Everything here is PROCEDURAL and visual. The twin's numbers (soil water,
// heat stress, status) come from the existing digital twin and drive the
// colour of the crops/ground; the spatial pattern across the field is a
// controlled simulation around that value, not measured per-location data.
//
// Public API (window.Landscape):
//   build({scene,camera,controls,renderer,crop,areaHa,twinState,statusFn,...})
//   applyWater(deltaMm), pick(raycaster), update(t, windOn, camera),
//   flyTo("aerial"|"field"|"crop"), setMode("health"|"water"), current, dispose()
// ---------------------------------------------------------------------------
(function () {
  "use strict";
  if (typeof THREE === "undefined") return;

  // ---- small helpers -------------------------------------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const toLin = (c) => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];
  const hexRGB = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const linHex = (hex) => toLin(hexRGB(hex));
  const mixRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function makeNoise(seed) {
    const rnd = mulberry32(seed);
    const perm = new Uint8Array(512), vals = new Float32Array(256), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { p[i] = i; vals[i] = rnd(); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const lat = (i, j) => vals[perm[perm[i & 255] + (j & 255)]];
    function n2(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return lerp(lerp(lat(xi, yi), lat(xi + 1, yi), u), lerp(lat(xi, yi + 1), lat(xi + 1, yi + 1), u), v);
    }
    function fbm(x, y, oct) {
      let s = 0, a = 1, f = 1, n = 0;
      for (let i = 0; i < (oct || 4); i++) { s += a * (n2(x * f, y * f) * 2 - 1); n += a; a *= 0.5; f *= 2.03; }
      return s / n;
    }
    return { n2, fbm };
  }

  // merge several geometries (each with a flat colour) into one coloured geometry
  function mergeColored(parts) {
    let total = 0;
    const gs = parts.map((p) => { const g = p.geo.index ? p.geo.toNonIndexed() : p.geo; total += g.attributes.position.count; return g; });
    const P = new Float32Array(total * 3), N = new Float32Array(total * 3), C = new Float32Array(total * 3);
    let o = 0;
    gs.forEach((g, k) => {
      const n = g.attributes.position.count, col = parts[k].color;
      P.set(g.attributes.position.array, o * 3);
      N.set(g.attributes.normal.array, o * 3);
      for (let i = 0; i < n; i++) { C[(o + i) * 3] = col[0]; C[(o + i) * 3 + 1] = col[1]; C[(o + i) * 3 + 2] = col[2]; }
      o += n;
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.BufferAttribute(C, 3));
    return out;
  }

  // ---- crop definitions (stylised canopy tufts, sizes in metres) ------------
  const CROPS = {
    RICE:      { h: 0.85, row: 0.9,  pl: 0.7,  blades: 7, bw: 0.04, tilt: 0.55, color: [0.36, 0.68, 0.25], head: { kind: "ear", col: [0.85, 0.76, 0.36], ry: 0.10 } },
    WHEAT:     { h: 0.9,  row: 0.75, pl: 0.6,  blades: 6, bw: 0.045, tilt: 0.32, color: [0.46, 0.67, 0.27], head: { kind: "ear", col: [0.90, 0.75, 0.34], ry: 0.15 } },
    MAIZE:     { h: 2.1,  row: 1.5,  pl: 1.1,  blades: 7, bw: 0.12,  tilt: 0.80, color: [0.26, 0.59, 0.22], head: { kind: "tassel", col: [0.88, 0.80, 0.44] } },
    SUGARCANE: { h: 2.8,  row: 2.0,  pl: 1.2,  blades: 10, bw: 0.07, tilt: 0.60, color: [0.27, 0.56, 0.25], head: null, stalks: 3 },
    COTTON:    { h: 1.1,  row: 1.5,  pl: 0.9,  blades: 8, bw: 0.09,  tilt: 0.85, color: [0.31, 0.61, 0.26], head: { kind: "boll", col: [0.97, 0.97, 0.93] } },
    GROUNDNUT: { h: 0.42, row: 1.0,  pl: 0.7,  blades: 9, bw: 0.07,  tilt: 1.05, color: [0.31, 0.63, 0.28], head: null },
    SOYABEAN:  { h: 0.8,  row: 1.0,  pl: 0.7,  blades: 9, bw: 0.08,  tilt: 0.75, color: [0.34, 0.64, 0.27], head: null },
  };

  function buildTuftGeometry(cfg) {
    const P = [], C = [], N = [];
    const cropLin = toLin(cfg.color);
    const pushTri = (a, b, c, sa, sb, sc, nrm) => {
      [a, b, c].forEach((v) => P.push(v[0], v[1], v[2]));
      [sa, sb, sc].forEach((s) => C.push(s, s, s));
      for (let i = 0; i < 3; i++) N.push(nrm[0], nrm[1], nrm[2]);
    };
    const H = cfg.h;
    const total = cfg.blades + (cfg.stalks || 0);
    for (let i = 0; i < total; i++) {
      const isStalk = i >= cfg.blades;
      const ang = (i / cfg.blades) * Math.PI * 2 + (i % 2) * 0.35 + i * 0.11;
      const len = H * (isStalk ? 0.98 : 0.78 + (i % 3) * 0.11);
      const tilt = isStalk ? 0.05 : cfg.tilt * (0.7 + 0.5 * (((i * 37) % 10) / 10));
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const sx = -dz, sz = dx;
      const bw = isStalk ? 0.03 : cfg.bw;
      const p0 = [dx * 0.01, 0, dz * 0.01];
      const p1 = [dx * len * 0.5 * Math.sin(tilt * 0.6), len * 0.5 * Math.cos(tilt * 0.4), dz * len * 0.5 * Math.sin(tilt * 0.6)];
      const p2 = [dx * len * Math.sin(tilt), len * Math.cos(tilt * 0.75), dz * len * Math.sin(tilt)];
      const bl = [p0[0] - sx * bw, 0, p0[2] - sz * bw], br = [p0[0] + sx * bw, 0, p0[2] + sz * bw];
      const ml = [p1[0] - sx * bw * 0.85, p1[1], p1[2] - sz * bw * 0.85], mr = [p1[0] + sx * bw * 0.85, p1[1], p1[2] + sz * bw * 0.85];
      const up = [0, 1, 0];
      pushTri(bl, br, ml, 0.42, 0.42, 0.85, up);
      pushTri(br, mr, ml, 0.42, 0.85, 0.85, up);
      pushTri(ml, mr, p2, 0.85, 0.85, 1.12, up);
    }
    // heads: ratio against the healthy crop colour so the instance tint keeps them golden/white
    if (cfg.head) {
      const hl = toLin(cfg.head.col);
      const ratio = [0, 1, 2].map((i) => clamp(hl[i] / cropLin[i], 0.5, 2.6));
      const addOcta = (cx, cy, cz, rx, ry, rz) => {
        const v = [[cx + rx, cy, cz], [cx - rx, cy, cz], [cx, cy + ry, cz], [cx, cy - ry, cz], [cx, cy, cz + rz], [cx, cy, cz - rz]];
        const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3]];
        faces.forEach((f) => {
          const a = v[f[0]], b = v[f[1]], c = v[f[2]];
          const u1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], u2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          let n = [u1[1] * u2[2] - u1[2] * u2[1], u1[2] * u2[0] - u1[0] * u2[2], u1[0] * u2[1] - u1[1] * u2[0]];
          const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
          const cen = [(a[0] + b[0] + c[0]) / 3 - cx, (a[1] + b[1] + c[1]) / 3 - cy, (a[2] + b[2] + c[2]) / 3 - cz];
          if (n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] < 0) n = [-n[0], -n[1], -n[2]];
          [a, b, c].forEach((p) => { P.push(p[0], p[1], p[2]); C.push(ratio[0] * 0.95, ratio[1] * 0.95, ratio[2] * 0.95); N.push(n[0], n[1], n[2]); });
        });
      };
      const k = cfg.head.kind;
      if (k === "ear") {
        const ry = cfg.head.ry;
        addOcta(0, H * 0.9, 0, 0.032, ry, 0.032);
      } else if (k === "tassel") {
        addOcta(0, H * 1.04, 0, 0.03, 0.22, 0.03);
        addOcta(0.05, H * 0.5, 0.0, 0.05, 0.13, 0.05); // cob
      } else if (k === "boll") {
        addOcta(0.12, H * 0.55, 0.05, 0.07, 0.07, 0.07);
        addOcta(-0.1, H * 0.7, -0.07, 0.07, 0.07, 0.07);
        addOcta(0.03, H * 0.82, -0.12, 0.06, 0.06, 0.06);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(N), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(C), 3));
    g.computeBoundingSphere();
    return g;
  }

  // shared wind uniforms for all crop tiles
  const U = { uTime: { value: 0 }, uWind: { value: 0 } };
  function makeCropMaterial() {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = U.uTime;
      shader.uniforms.uWind = U.uWind;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
          float hh = max(position.y, 0.0);
          float sway = sin(uTime * 1.7 + ph) * 0.03 + uWind * (0.10 + sin(uTime * 4.2 + ph) * 0.14 + sin(uTime * 7.3 + ph * 1.7) * 0.05);
          transformed.x += sway * hh;
          transformed.z += sway * 0.55 * hh;
        #endif`);
      // flat blades are lit from above on both faces (no dark undersides)
      shader.fragmentShader = shader.fragmentShader.replace(/gl_FrontFacing/g, "true");
    };
    return m;
  }

  // ---- colour ramps --------------------------------------------------------
  const HEALTH_STOPS = [
    [0.0, toLin([0.40, 0.27, 0.15])],   // brown / severe stress
    [0.30, toLin([0.72, 0.58, 0.22])],  // yellow-brown
    [0.62, toLin([0.66, 0.72, 0.27])],  // yellow-green
  ];
  function healthColor(h, cropLin) {
    if (h >= 0.62) return mixRGB(HEALTH_STOPS[2][1], cropLin, (h - 0.62) / 0.38);
    if (h >= 0.30) return mixRGB(HEALTH_STOPS[1][1], HEALTH_STOPS[2][1], (h - 0.30) / 0.32);
    return mixRGB(HEALTH_STOPS[0][1], HEALTH_STOPS[1][1], h / 0.30);
  }
  function healthFromWater(w) {
    if (w <= 15) return 0;
    if (w <= 40) return ((w - 15) / 25) * 0.35;
    if (w <= 70) return 0.35 + ((w - 40) / 30) * 0.45;
    if (w <= 110) return 0.8 + ((w - 70) / 40) * 0.2;
    return 1;
  }
  const WATER_STOPS = [
    [0, [0.66, 0.33, 0.17]], [25, [0.84, 0.61, 0.24]], [45, [0.90, 0.86, 0.61]],
    [70, [0.44, 0.76, 0.79]], [100, [0.18, 0.53, 0.79]], [150, [0.11, 0.31, 0.62]],
  ];
  function waterRamp(w) {
    for (let i = 0; i < WATER_STOPS.length - 1; i++) {
      const a = WATER_STOPS[i], b = WATER_STOPS[i + 1];
      if (w <= b[0]) return mixRGB(a[1], b[1], (w - a[0]) / (b[0] - a[0]));
    }
    return WATER_STOPS[WATER_STOPS.length - 1][1];
  }
  const cssRGB = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

  // ---- UI (layer toggle, view buttons, legend) ------------------------------
  function injectStyle() {
    if (document.getElementById("ls-style")) return;
    const st = document.createElement("style");
    st.id = "ls-style";
    st.textContent = `
    .ls-ui { position:absolute; inset:0; pointer-events:none; font-family:'Segoe UI',system-ui,sans-serif; }
    .ls-glass { background:rgba(8,20,24,.66); border:1px solid rgba(79,209,232,.3); border-radius:10px; backdrop-filter:blur(6px); color:#dbe9ec; }
    .ls-top { position:absolute; top:12px; right:12px; display:flex; gap:6px; pointer-events:auto; padding:5px; }
    .ls-top button, .ls-toggle button { all:unset; cursor:pointer; padding:6px 11px; font-size:10.5px; letter-spacing:.16em; color:#9fc7cf; border-radius:7px; }
    .ls-top button:hover, .ls-toggle button:hover { color:#fff; background:rgba(79,209,232,.14); }
    .ls-top button.on, .ls-toggle button.on { color:#06201a; background:#7ff0b4; font-weight:700; }
    .ls-legend { position:absolute; left:12px; bottom:12px; width:236px; padding:10px 12px; pointer-events:auto; }
    .ls-legend .t { font-size:10px; letter-spacing:.2em; color:#7ff0b4; font-weight:700; }
    .ls-legend .bar { height:7px; border-radius:4px; margin:8px 0 4px; }
    .ls-legend .sc { display:flex; justify-content:space-between; font-size:9px; letter-spacing:.12em; color:#8fb4bc; }
    .ls-toggle { display:flex; gap:4px; margin-top:9px; }
    .ls-note { font-size:9px; line-height:1.45; color:#7fa2aa; margin-top:8px; letter-spacing:.04em; }
    .ls-level { position:absolute; right:12px; bottom:12px; padding:8px 12px; text-align:right; font-family:Consolas,'Courier New',monospace; font-size:10.5px; letter-spacing:.14em; line-height:1.6; }
    .ls-level b { color:#7ff0b4; }
    .ls-level .ladder span { opacity:.38; } .ls-level .ladder span.on { opacity:1; color:#7ff0b4; }
    @media (max-width:760px){ .ls-legend{width:190px;} .ls-level{display:none;} }`;
    document.head.appendChild(st);
  }

  // ---- main build ----------------------------------------------------------
  let CURRENT = null;

  function build(ctx) {
    dispose();
    injectStyle();

    const scene = ctx.scene, camera = ctx.camera, controls = ctx.controls, renderer = ctx.renderer;
    const crop = (ctx.crop || "RICE").toUpperCase();
    const cfg = CROPS[crop] || CROPS.RICE;
    const cropLin = toLin(cfg.color);
    const areaHa = Math.max(0.2, Number(ctx.areaHa) || 2);
    const seed = hashStr(crop + "|" + areaHa.toFixed(2) + "|" + (ctx.locKey || ""));
    const rnd = mulberry32(seed);
    const noise = makeNoise(seed ^ 0x9e3779b9);
    const maxInst = window.LANDSCAPE_MAX_INSTANCES || 30000;

    // physical size from the area the user entered (1 ha = 10,000 m2)
    const area_m2 = areaHa * 10000;
    const W = Math.sqrt(area_m2 * 1.55), D = area_m2 / W;
    const span = Math.max(W, D * 1.35);
    const E = Math.max(1500, span * 5);        // half-extent of the surrounding terrain

    // ---- layout (metres, farm centred on origin, +z toward camera / south) ----
    const bi = 6, cw = 3.0, pw = 4.0;
    const Yd = clamp(D * 0.12, 18, 55);
    const zN = -D / 2 + bi, zS = D / 2 - Yd - 2;
    const zA1 = zN + (zS - zN) * 0.46;
    const hChan = { z0: zA1 + 1, z1: zA1 + 1 + cw };
    const hPath = { z0: hChan.z1, z1: hChan.z1 + pw * 0.6 };
    const zB0 = hPath.z1 + 1;
    const xm = -W * 0.04;
    const vChan = { x0: xm - (cw + pw) / 2, x1: xm - (cw + pw) / 2 + cw };
    const vPath = { x0: vChan.x1, x1: vChan.x1 + pw };
    const xc = (vChan.x0 + vChan.x1) / 2;
    const pond = { x: xc, z: D / 2 - Yd * 0.5, rx: clamp(W * 0.09, 14, 70), rz: Yd * 0.36 };
    const roadZ = D / 2 + 16;
    const laneX = W * 0.36;

    const wobFn = (ph1, ph2) => (u) => 0.22 * Math.sin(u * 0.045 + ph1) + 0.1 * Math.sin(u * 0.013 + ph2);
    const plots = [
      { name: "FIELD A", rect: { x0: -W / 2 + bi, x1: W / 2 - bi, z0: zN, z1: zA1 }, angle: 0.025, rowMul: 1.0, hMul: 1.0, soil: "#8b6a44", waterOff: 10, wob: wobFn(rnd() * 6, rnd() * 6) },
      { name: "FIELD B", rect: { x0: -W / 2 + bi, x1: vChan.x0 - 1, z0: zB0, z1: zS }, angle: Math.PI / 2 + 0.035, rowMul: 1.12, hMul: 0.9, soil: "#7c5d3d", waterOff: -18, wob: wobFn(rnd() * 6, rnd() * 6) },
      { name: "FIELD C", rect: { x0: vPath.x1 + 1, x1: W / 2 - bi, z0: zB0, z1: zS }, angle: -0.05, rowMul: 0.95, hMul: 1.06, soil: "#936f47", waterOff: 2, wob: wobFn(rnd() * 6, rnd() * 6) },
    ].filter((p) => p.rect.x1 - p.rect.x0 > 4 && p.rect.z1 - p.rect.z0 > 4);

    // ---- terrain height -----------------------------------------------------
    const slopeX = 0.011, slopeZ = -0.006;
    function baseH(x, z) {
      const dx = Math.max(Math.abs(x) - W / 2, 0), dz = Math.max(Math.abs(z) - D / 2, 0);
      const dFarm = Math.hypot(dx, dz);
      const near = noise.fbm(x * 0.008 + 10, z * 0.008 + 3, 3) * 1.8;
      const far = noise.fbm(x * 0.0025, z * 0.0025, 4);
      return slopeX * x + slopeZ * z + near * (0.55 + 0.45 * smooth(0, 200, dFarm)) + far * 38 * smooth(120, 900, dFarm);
    }
    const pondFactor = (x, z) => 1 - smooth(0.6, 1.0, Math.hypot((x - pond.x) / (pond.rx * 1.35), (z - pond.z) / (pond.rz * 1.35)));
    const H = (x, z) => baseH(x, z) - 1.8 * pondFactor(x, z);
    const hRef = baseH(0, 0);
    const waterLevelY = baseH(pond.x, pond.z) - 0.95;

    // ---- spatial soil-water pattern (offset in mm around the twin's value) ----
    function plotAt(x, z) {
      for (let i = 0; i < plots.length; i++) { const r = plots[i].rect; if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return plots[i]; }
      return null;
    }
    function waterOffsetAt(x, z, plot) {
      let off = plot ? plot.waterOff : 0;
      off += noise.fbm(x * 0.018 + 50, z * 0.018 + 20, 3) * 18;
      off += 12 * Math.exp(-Math.abs(z - (hChan.z0 + cw / 2)) / 28) + 9 * Math.exp(-Math.abs(x - xc) / 24);
      off -= (baseH(x, z) - hRef) * 5;
      return off;
    }

    const group = new THREE.Group();
    group.name = "landscape";
    scene.add(group);

    const anis = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);

    // ======================= INSTANCED CROP ROWS =======================
    let est = 0;
    plots.forEach((p) => { const r = p.rect; est += ((r.x1 - r.x0) * (r.z1 - r.z0)) / (cfg.row * p.rowMul * cfg.pl); });
    const kScale = Math.max(1, Math.sqrt(est / maxInst));
    const widthScale = Math.pow(kScale, 0.9), heightScale = Math.pow(kScale, 0.25);

    const baseState = ctx.twinState || { soil_water_mm: 80, heat_stress: false };
    const tileSize = clamp(span / 7, 25, 90);
    const tiles = new Map();
    const tuftGeo = buildTuftGeometry(cfg);
    const cropMat = makeCropMaterial();
    let totalInstances = 0;

    plots.forEach((p, pi) => {
      const r = p.rect;
      const row = cfg.row * p.rowMul * kScale, pl = cfg.pl * kScale;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const hx = (r.x1 - r.x0) / 2 - 0.8, hz = (r.z1 - r.z0) / 2 - 0.8;
      const R = Math.hypot(hx, hz), ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      const nRows = Math.ceil(R / row);
      p.row = row; p.nRows = nRows; p.cx = cx; p.cz = cz; p.R = R;
      for (let ri = -nRows; ri <= nRows; ri++) {
        const wBase = ri * row;
        for (let u = -R; u <= R; u += pl) {
          const w = wBase + p.wob(u);
          const x = cx + u * ca - w * sa, z = cz + u * sa + w * ca;
          if (Math.abs(x - cx) > hx || Math.abs(z - cz) > hz) continue;
          const jx = x + (rnd() - 0.5) * pl * 0.12, jz = z + (rnd() - 0.5) * row * 0.06;
          const tx = Math.floor((jx + W) / tileSize), tz = Math.floor((jz + D) / tileSize);
          const key = tx + "," + tz;
          let t = tiles.get(key);
          if (!t) { t = { xs: [], zs: [], off: [], hm: [], vary: [], plot: [] }; tiles.set(key, t); }
          const off = waterOffsetAt(jx, jz, p);
          t.xs.push(jx); t.zs.push(jz); t.off.push(off); t.plot.push(pi);
          t.hm.push(p.hMul); t.vary.push(0.9 + rnd() * 0.2);
          totalInstances++;
        }
      }
    });

    const tileMeshes = [];
    tiles.forEach((t) => {
      const n = t.xs.length;
      const mesh = new THREE.InstancedMesh(tileGeometry(tuftGeo, t, tileSize, cfg.h), cropMat, n);
      mesh.frustumCulled = true;
      const arr = mesh.instanceMatrix.array;
      for (let i = 0; i < n; i++) {
        const x = t.xs[i], z = t.zs[i], y = H(x, z) - 0.02;
        const ang = rnd() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
        const hl = healthFromWater(clamp(baseState.soil_water_mm + t.off[i], 0, 150));
        const sxz = widthScale * (0.88 + rnd() * 0.26);
        const sy = heightScale * t.hm[i] * (0.78 + 0.22 * hl) * (0.88 + rnd() * 0.24);
        const o = i * 16;
        arr[o] = sxz * c; arr[o + 1] = 0; arr[o + 2] = -sxz * s; arr[o + 3] = 0;
        arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = sxz * s; arr[o + 9] = 0; arr[o + 10] = sxz * c; arr[o + 11] = 0;
        arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      t.mesh = mesh; t.off = Float32Array.from(t.off); t.vary = Float32Array.from(t.vary);
      group.add(mesh);
      tileMeshes.push(t);
    });

    function tileGeometry(base, t, size, h) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", base.attributes.position);
      g.setAttribute("normal", base.attributes.normal);
      g.setAttribute("color", base.attributes.color);
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      for (let i = 0; i < t.xs.length; i++) { minx = Math.min(minx, t.xs[i]); maxx = Math.max(maxx, t.xs[i]); minz = Math.min(minz, t.zs[i]); maxz = Math.max(maxz, t.zs[i]); }
      const c = new THREE.Vector3((minx + maxx) / 2, 0, (minz + maxz) / 2);
      g.boundingSphere = new THREE.Sphere(c, Math.hypot(maxx - minx, maxz - minz) / 2 + 40 + h * 3);
      return g;
    }

    // ======================= GROUND TEXTURES =======================
    const margin = 40;
    const Wt = W + margin * 2, Dt = D + margin * 2;
    const TW = 2048, TH = 1024, sx = TW / Wt, sz = TH / Dt;

    const soilCv = document.createElement("canvas");
    soilCv.width = TW; soilCv.height = TH;
    const g = soilCv.getContext("2d");
    g.setTransform(sx, 0, 0, sz, sx * Wt / 2, sz * Dt / 2);
    // verge grass
    g.fillStyle = "#5e7a3a"; g.fillRect(-Wt / 2, -Dt / 2, Wt, Dt);
    for (let i = 0; i < 5000; i++) {
      const v = 70 + Math.floor(rnd() * 50);
      g.fillStyle = `rgba(${v + 10},${v + 50},${v - 20},0.3)`;
      g.fillRect((rnd() - 0.5) * Wt, (rnd() - 0.5) * Dt, 0.8 + rnd() * 2, 0.8 + rnd() * 2);
    }
    // farm interior earth
    g.fillStyle = "#7d6b47"; g.fillRect(-W / 2, -D / 2, W, D);
    // perimeter path
    g.strokeStyle = "#b8a077"; g.lineWidth = 2.4; g.strokeRect(-W / 2 + 3.2, -D / 2 + 3.2, W - 6.4, D - 6.4);
    // plots with furrows
    plots.forEach((p) => {
      const r = p.rect;
      g.fillStyle = p.soil; g.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
      for (let i = 0; i < ((r.x1 - r.x0) * (r.z1 - r.z0)) / 90; i++) {
        g.fillStyle = `rgba(${40 + rnd() * 40},${30 + rnd() * 25},${15 + rnd() * 15},0.22)`;
        g.fillRect(r.x0 + rnd() * (r.x1 - r.x0), r.z0 + rnd() * (r.z1 - r.z0), 0.5 + rnd() * 1.2, 0.5 + rnd() * 1.2);
      }
      g.save(); g.beginPath(); g.rect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0); g.clip();
      g.lineWidth = p.row * 0.34; g.strokeStyle = "rgba(52,36,22,0.62)"; g.lineCap = "butt";
      const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      for (let ri = -p.nRows; ri <= p.nRows; ri++) {
        g.beginPath();
        for (let u = -p.R; u <= p.R; u += 4) {
          const w = (ri + 0.5) * p.row + p.wob(u);
          const x = p.cx + u * ca - w * sa, z = p.cz + u * sa + w * ca;
          if (u === -p.R) g.moveTo(x, z); else g.lineTo(x, z);
        }
        g.stroke();
      }
      g.restore();
      g.strokeStyle = "rgba(50,38,24,0.8)"; g.lineWidth = 0.7; g.strokeRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
    });
    // yard pad + lane + road
    g.fillStyle = "#8e8573"; g.fillRect(-W / 2 + bi, zS + 2, W - bi * 2, D / 2 - 3 - (zS + 2));
    g.fillStyle = "#a89270"; g.fillRect(laneX - 2.6, D / 2 - Yd, 5.2, roadZ - (D / 2 - Yd));
    g.fillRect(-Wt / 2, roadZ - 3.5, Wt, 7);
    g.fillStyle = "rgba(60,48,30,0.35)"; g.fillRect(-Wt / 2, roadZ - 3.5, Wt, 0.5); g.fillRect(-Wt / 2, roadZ + 3, Wt, 0.5);
    // channels + paths
    const bank = "#4a3d2a", water = "#3c7fa8";
    g.fillStyle = "#b59a6b"; g.fillRect(-W / 2 + bi, hPath.z0, W - bi * 2, hPath.z1 - hPath.z0);
    g.fillRect(vPath.x0, hPath.z1, vPath.x1 - vPath.x0, (pond.z - pond.rz) - hPath.z1);
    g.fillStyle = bank; g.fillRect(-W / 2 + bi, hChan.z0 - 0.4, W - bi * 2, cw + 0.8); g.fillRect(vChan.x0 - 0.4, hChan.z1, cw + 0.8, (pond.z - pond.rz * 0.6) - hChan.z1);
    g.fillStyle = water; g.fillRect(-W / 2 + bi, hChan.z0, W - bi * 2, cw); g.fillRect(vChan.x0, hChan.z1, cw, (pond.z - pond.rz * 0.6) - hChan.z1);
    g.fillStyle = "rgba(190,225,240,0.45)"; g.fillRect(-W / 2 + bi, hChan.z0 + cw * 0.4, W - bi * 2, cw * 0.2); g.fillRect(vChan.x0 + cw * 0.4, hChan.z1, cw * 0.2, (pond.z - pond.rz * 0.6) - hChan.z1);
    // reservoir
    g.fillStyle = "#6d5f45"; g.beginPath(); g.ellipse(pond.x, pond.z, pond.rx + 3, pond.rz + 3, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#2f6f93"; g.beginPath(); g.ellipse(pond.x, pond.z, pond.rx, pond.rz, 0, 0, Math.PI * 2); g.fill();

    // water-state overlay grid (low res), re-composited when the twin changes
    const GX = 160, GZ = Math.max(24, Math.round(GX * Dt / Wt));
    const gridOff = new Float32Array(GX * GZ), gridIn = new Uint8Array(GX * GZ);
    for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) {
      const x = -Wt / 2 + ((i + 0.5) / GX) * Wt, z = -Dt / 2 + ((j + 0.5) / GZ) * Dt;
      const pl = plotAt(x, z);
      gridIn[j * GX + i] = pl ? 1 : 0;
      gridOff[j * GX + i] = pl ? waterOffsetAt(x, z, pl) : 0;
    }
    const ovCv = document.createElement("canvas"); ovCv.width = GX; ovCv.height = GZ;
    const ovCtx = ovCv.getContext("2d"); const ovImg = ovCtx.createImageData(GX, GZ);
    const groundCv = document.createElement("canvas"); groundCv.width = TW; groundCv.height = TH;
    const gg = groundCv.getContext("2d");
    const groundTex = new THREE.CanvasTexture(groundCv);
    groundTex.encoding = THREE.sRGBEncoding; groundTex.anisotropy = anis;

    let mode = "health", deltaMm = 0;
    function repaintGround() {
      const base = baseState.soil_water_mm + deltaMm;
      for (let i = 0; i < GX * GZ; i++) {
        const o = i * 4;
        if (!gridIn[i]) { ovImg.data[o] = 255; ovImg.data[o + 1] = 255; ovImg.data[o + 2] = 255; ovImg.data[o + 3] = mode === "water" ? 0 : 255; continue; }
        const w = clamp(base + gridOff[i], 0, 150);
        if (mode === "water") {
          const c = waterRamp(w);
          ovImg.data[o] = c[0] * 255; ovImg.data[o + 1] = c[1] * 255; ovImg.data[o + 2] = c[2] * 255; ovImg.data[o + 3] = 215;
        } else {
          const d = lerp(1.0, 0.66, clamp(w / 120, 0, 1)); // wetter soil reads darker
          ovImg.data[o] = ovImg.data[o + 1] = ovImg.data[o + 2] = d * 255; ovImg.data[o + 3] = 255;
        }
      }
      ovCtx.putImageData(ovImg, 0, 0);
      gg.setTransform(1, 0, 0, 1, 0, 0);
      gg.globalCompositeOperation = "source-over"; gg.globalAlpha = 1;
      gg.drawImage(soilCv, 0, 0);
      gg.imageSmoothingEnabled = true; gg.imageSmoothingQuality = "high";
      gg.globalCompositeOperation = mode === "water" ? "source-over" : "multiply";
      gg.drawImage(ovCv, 0, 0, TW, TH);
      gg.globalCompositeOperation = "source-over";
      groundTex.needsUpdate = true;
    }
    repaintGround();

    // farm ground mesh
    const gsx = Math.min(220, Math.round(Wt / 3)), gsz = Math.min(160, Math.round(Dt / 3));
    const groundGeo = new THREE.PlaneGeometry(Wt, Dt, gsx, gsz);
    groundGeo.rotateX(-Math.PI / 2);
    {
      const pa = groundGeo.attributes.position;
      for (let i = 0; i < pa.count; i++) pa.setY(i, H(pa.getX(i), pa.getZ(i)));
      groundGeo.computeVertexNormals();
    }
    const groundMesh = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }));
    groundMesh.name = "farm-ground";
    group.add(groundMesh);

    // ======================= SURROUNDING TERRAIN =======================
    const svCv = document.createElement("canvas"); svCv.width = 2048; svCv.height = 2048;
    const sv = svCv.getContext("2d"); const ssx = 2048 / (2 * E);
    sv.setTransform(ssx, 0, 0, ssx, 1024, 1024);
    sv.fillStyle = "#6a7e3b"; sv.fillRect(-E, -E, 2 * E, 2 * E);
    const palette = ["#7c9a43", "#8aa84b", "#a3a84f", "#b09a55", "#8b7a4a", "#657f3a", "#c0b070", "#5d7a3a", "#94a84e"];
    for (let i = 0; i < 380; i++) {
      const px = (rnd() - 0.5) * 2 * E, pz = (rnd() - 0.5) * 2 * E;
      const pw2 = 40 + rnd() * 160, ph2 = 35 + rnd() * 130, a = Math.floor(rnd() * 4) * 0.4 + rnd() * 0.15;
      sv.save(); sv.translate(px, pz); sv.rotate(a);
      sv.fillStyle = palette[Math.floor(rnd() * palette.length)]; sv.globalAlpha = 0.85;
      sv.fillRect(-pw2 / 2, -ph2 / 2, pw2, ph2);
      sv.globalAlpha = 0.18; sv.strokeStyle = "#2c3a18"; sv.lineWidth = 1.2;
      for (let y = -ph2 / 2; y < ph2 / 2; y += 5) { sv.beginPath(); sv.moveTo(-pw2 / 2, y); sv.lineTo(pw2 / 2, y); sv.stroke(); }
      sv.globalAlpha = 0.5; sv.lineWidth = 1.4; sv.strokeRect(-pw2 / 2, -ph2 / 2, pw2, ph2);
      sv.restore();
    }
    sv.globalAlpha = 1;
    sv.strokeStyle = "#b3a07a"; sv.lineCap = "butt";
    sv.lineWidth = 7; sv.beginPath(); sv.moveTo(-E, roadZ); sv.lineTo(E, roadZ); sv.stroke();
    sv.lineWidth = 5; sv.beginPath(); sv.moveTo(-W * 0.9, roadZ); sv.lineTo(-W * 0.9 - 80, -E); sv.stroke();
    sv.beginPath(); sv.moveTo(W * 0.8, roadZ); sv.lineTo(W * 0.8 + 200, E); sv.stroke();
    sv.beginPath(); sv.moveTo(laneX + 2, roadZ); sv.lineTo(laneX + 160, roadZ + E); sv.stroke();
    sv.strokeStyle = "#4f86a8"; sv.lineWidth = 6; sv.beginPath(); sv.moveTo(-E, -D / 2 - 160); sv.bezierCurveTo(-E * 0.4, -D / 2 - 260, E * 0.2, -D / 2 - 90, E, -D / 2 - 220); sv.stroke();
    const surroundTex = new THREE.CanvasTexture(svCv); surroundTex.encoding = THREE.sRGBEncoding; surroundTex.anisotropy = anis;
    const tgeo = new THREE.PlaneGeometry(2 * E, 2 * E, 256, 256); tgeo.rotateX(-Math.PI / 2);
    {
      const pa = tgeo.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), z = pa.getZ(i);
        const ox = Math.max(Math.abs(x) - W / 2, 0), oz = Math.max(Math.abs(z) - D / 2, 0);
        const inFarm = 1 - smooth(margin * 0.75, margin, Math.hypot(ox, oz));
        pa.setY(i, H(x, z) - 1.2 * inFarm);
      }
      tgeo.computeVertexNormals();
    }
    const terrain = new THREE.Mesh(tgeo, new THREE.MeshLambertMaterial({ map: surroundTex }));
    terrain.name = "surround-terrain";
    group.add(terrain);

    // ======================= WATER (reservoir + channels) =======================
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f6f93, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.92 });
    const pondMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 48), waterMat);
    pondMesh.rotation.x = -Math.PI / 2; pondMesh.scale.set(pond.rx, pond.rz, 1); pondMesh.position.set(pond.x, waterLevelY, pond.z);
    group.add(pondMesh);
    function ribbon(pts, width, yOff, mat) {
      const pos = [], idx = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const nx = -dz * width / 2, nz = dx * width / 2;
        pos.push(pts[i][0] + nx, H(pts[i][0] + nx, pts[i][1] + nz) + yOff, pts[i][1] + nz, pts[i][0] - nx, H(pts[i][0] - nx, pts[i][1] - nz) + yOff, pts[i][1] - nz);
        if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      return new THREE.Mesh(geo, mat);
    }
    const chanMat = new THREE.MeshStandardMaterial({ color: 0x3b86b0, roughness: 0.2, metalness: 0.05, transparent: true, opacity: 0.88, side: THREE.DoubleSide });
    const samp = (x0, z0, x1, z1, step) => { const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step)); const o = []; for (let i = 0; i <= n; i++) o.push([lerp(x0, x1, i / n), lerp(z0, z1, i / n)]); return o; };
    group.add(ribbon(samp(-W / 2 + bi, hChan.z0 + cw / 2, W / 2 - bi, hChan.z0 + cw / 2, 5), cw * 0.78, 0.07, chanMat));
    group.add(ribbon(samp(xc, hChan.z1, xc, pond.z - pond.rz * 0.6, 5), cw * 0.78, 0.07, chanMat));

    // ======================= FENCE, BOUNDARY, LABELS =======================
    const perim = [];
    const addEdge = (x0, z0, x1, z1) => { const pts = samp(x0, z0, x1, z1, 5); pts.pop(); pts.forEach((p) => perim.push(p)); };
    addEdge(-W / 2, -D / 2, W / 2, -D / 2); addEdge(W / 2, -D / 2, W / 2, D / 2); addEdge(W / 2, D / 2, -W / 2, D / 2); addEdge(-W / 2, D / 2, -W / 2, -D / 2);
    const postGeo = new THREE.BoxGeometry(0.14, 1.3, 0.14).translate(0, 0.65, 0);
    const postsList = perim.filter((p) => !(Math.abs(p[1] - D / 2) < 0.1 && Math.abs(p[0] - laneX) < 4));
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(...linHex(0x5b4a35)) }), postsList.length);
    { const m = new THREE.Matrix4(); postsList.forEach((p, i) => { m.makeTranslation(p[0], H(p[0], p[1]), p[1]); posts.setMatrixAt(i, m); }); posts.instanceMatrix.needsUpdate = true; posts.frustumCulled = false; }
    group.add(posts);
    const wireP = [];
    for (let i = 0; i < perim.length; i++) {
      const a = perim[i], b = perim[(i + 1) % perim.length];
      if ((Math.abs(a[1] - D / 2) < 0.1 && Math.abs(a[0] - laneX) < 4) || (Math.abs(b[1] - D / 2) < 0.1 && Math.abs(b[0] - laneX) < 4)) continue;
      [0.55, 1.05].forEach((hh) => wireP.push(a[0], H(a[0], a[1]) + hh, a[1], b[0], H(b[0], b[1]) + hh, b[1]));
    }
    const wireGeo = new THREE.BufferGeometry(); wireGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(wireP), 3));
    group.add(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x2b2b2b, transparent: true, opacity: 0.7 })));

    // glowing selected-farm boundary + soft curtain
    const bLine = [];
    perim.forEach((p) => bLine.push(new THREE.Vector3(p[0], H(p[0], p[1]) + 0.25, p[1])));
    group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(bLine), new THREE.LineBasicMaterial({ color: 0x4FD1E8, transparent: true, opacity: 0.95 })));
    {
      const curtainH = clamp(span * 0.03, 6, 22), pos = [], uv = [], idx = [];
      perim.forEach((p, i) => {
        const y = H(p[0], p[1]);
        pos.push(p[0], y + 0.1, p[1], p[0], y + curtainH, p[1]); uv.push(0, 0, 0, 1);
        const k = i * 2, n = (i + 1) % perim.length * 2; idx.push(k, n, k + 1, n, n + 1, k + 1);
      });
      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      cg.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2)); cg.setIndex(idx);
      const gc = document.createElement("canvas"); gc.width = 4; gc.height = 64; const gx = gc.getContext("2d");
      const gr = gx.createLinearGradient(0, 64, 0, 0); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(0,0,0,1)");
      gx.fillStyle = gr; gx.fillRect(0, 0, 4, 64);
      group.add(new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0x4FD1E8, alphaMap: new THREE.CanvasTexture(gc), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
    }
    // corner beacons
    [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]].forEach((c) => {
      const bh = clamp(span * 0.06, 12, 45);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, bh, 6).translate(0, bh / 2, 0), new THREE.MeshBasicMaterial({ color: 0x4FD1E8, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
      b.position.set(c[0], H(c[0], c[1]), c[1]); group.add(b);
    });

    function labelSprite(text, sub) {
      const cv = document.createElement("canvas"); cv.width = 512; cv.height = 128; const c = cv.getContext("2d");
      c.fillStyle = "rgba(8,20,24,0.72)"; c.strokeStyle = "rgba(79,209,232,0.7)"; c.lineWidth = 3;
      c.beginPath(); c.roundRect ? c.roundRect(4, 4, 504, 120, 18) : c.rect(4, 4, 504, 120); c.fill(); c.stroke();
      c.textAlign = "center"; c.fillStyle = "#eaf7f9"; c.font = "bold 44px 'Segoe UI',Arial,sans-serif"; c.fillText(text, 256, sub ? 62 : 82);
      if (sub) { c.fillStyle = "#7ff0b4"; c.font = "28px 'Segoe UI',Arial,sans-serif"; c.fillText(sub, 256, 104); }
      const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      const hgt = clamp(span * 0.028, 4, 26); sp.scale.set(hgt * 4, hgt, 1); sp.renderOrder = 10;
      return sp;
    }
    const sprites = [];
    const lblY = clamp(span * 0.05, 10, 40);
    plots.forEach((p) => { const s = labelSprite(p.name, crop); s.position.set(p.cx, H(p.cx, p.cz) + lblY, p.cz); group.add(s); sprites.push(s); });
    { const s = labelSprite("RESERVOIR"); s.position.set(pond.x, waterLevelY + lblY * 0.8, pond.z); group.add(s); sprites.push(s); }
    { const s = labelSprite("FARM YARD"); s.position.set(W * 0.2, H(W * 0.2, D / 2 - Yd / 2) + lblY * 0.8, D / 2 - Yd / 2); group.add(s); sprites.push(s); }
    { const s = labelSprite("SELECTED FARM", areaHa.toFixed(1) + " HA · " + Math.round(W) + " × " + Math.round(D) + " m"); s.position.set(0, H(0, -D / 2) + lblY * 1.5, -D / 2 - 4); group.add(s); sprites.push(s); }

    // ======================= BUILDINGS, ROAD UTILITIES =======================
    const bMat = (hex) => new THREE.MeshLambertMaterial({ color: new THREE.Color(...linHex(hex)) });
    function box(w, h, d, x, z, hex, y0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bMat(hex)); m.position.set(x, (y0 !== undefined ? y0 : H(x, z)) + h / 2, z); group.add(m); return m; }
    const yardZ = D / 2 - Yd * 0.45;
    box(7, 3.4, 5, pond.x + pond.rx + 12, yardZ, 0xcfc7b8); box(7.6, 0.4, 5.6, pond.x + pond.rx + 12, yardZ, 0x7a6a5a, H(pond.x + pond.rx + 12, yardZ) + 3.4);
    box(16, 4.6, 8, W * 0.16, yardZ, 0xb9b2a6); box(16.6, 0.5, 8.6, W * 0.16, yardZ, 0x6f7f8a, H(W * 0.16, yardZ) + 4.6);
    { const x = W * 0.27, tank = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4.4, 14), bMat(0x6d8fa3)); tank.position.set(x, H(x, yardZ) + 3.8, yardZ); group.add(tank);
      box(0.4, 3.4, 0.4, x - 1.5, yardZ - 1.5, 0x555555); box(0.4, 3.4, 0.4, x + 1.5, yardZ + 1.5, 0x555555); box(0.4, 3.4, 0.4, x - 1.5, yardZ + 1.5, 0x555555); box(0.4, 3.4, 0.4, x + 1.5, yardZ - 1.5, 0x555555); }

    const poleG = mergeColored([
      { geo: new THREE.CylinderGeometry(0.12, 0.17, 9, 6).translate(0, 4.5, 0), color: linHex(0x5b4a35) },
      { geo: new THREE.BoxGeometry(3.2, 0.14, 0.14).translate(0, 8.6, 0), color: linHex(0x4a3b2a) },
    ]);
    const poleX = []; for (let x = -E * 0.3; x <= E * 0.3; x += 50) poleX.push(x);
    const poles = new THREE.InstancedMesh(poleG, new THREE.MeshLambertMaterial({ vertexColors: true }), poleX.length);
    { const m = new THREE.Matrix4(); poleX.forEach((x, i) => { m.makeTranslation(x, H(x, roadZ - 6), roadZ - 6); poles.setMatrixAt(i, m); }); poles.frustumCulled = false; }
    group.add(poles);
    const wp = [];
    for (let i = 0; i < poleX.length - 1; i++) {
      [-1.4, 1.4].forEach((off) => {
        let prev = null;
        for (let s = 0; s <= 8; s++) {
          const t = s / 8, x = lerp(poleX[i], poleX[i + 1], t), y0 = lerp(H(poleX[i], roadZ - 6), H(poleX[i + 1], roadZ - 6), t) + 8.6 - Math.sin(t * Math.PI) * 1.2;
          const p = [x, y0, roadZ - 6 + off * 0.0 + (off < 0 ? -0.0 : 0.0)];
          if (prev) wp.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
          prev = p;
        }
      });
    }
    { const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(wp), 3)); group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6 }))); }

    // ======================= TREES + PALMS =======================
    const treeG = mergeColored([
      { geo: new THREE.CylinderGeometry(0.22, 0.38, 4.2, 6).translate(0, 2.1, 0), color: linHex(0x5b4630) },
      { geo: new THREE.IcosahedronGeometry(2.7, 1).scale(1, 0.85, 1).translate(0, 5.6, 0), color: linHex(0x4f7d33) },
    ]);
    const palmParts = [{ geo: new THREE.CylinderGeometry(0.16, 0.3, 9, 6).translate(0, 4.5, 0), color: linHex(0x7a6a52) }];
    for (let f = 0; f < 9; f++) {
      const a = (f / 9) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), pos = [];
      for (let s = 0; s <= 4; s++) {
        const t = s / 4, r = t * 4.2, y = 9 + Math.sin(t * 2.2) * 1.3 - t * t * 2.2, w = 0.55 * Math.sin(Math.PI * (0.15 + t * 0.85)) + 0.05;
        pos.push([dx * r - dz * w, y, dz * r + dx * w], [dx * r + dz * w, y, dz * r - dx * w]);
      }
      const fg = new THREE.BufferGeometry(), arr = [], ind = [];
      pos.forEach((p) => arr.push(p[0], p[1], p[2]));
      for (let s = 0; s < 4; s++) { const k = s * 2; ind.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      fg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3)); fg.setIndex(ind); fg.computeVertexNormals();
      palmParts.push({ geo: fg, color: linHex(f % 2 ? 0x3f7a2e : 0x4c8a35) });
    }
    const palmG = mergeColored(palmParts);
    const treePts = [], palmPts = [];
    const awayFromFarm = (x, z, pad) => Math.max(Math.abs(x) - W / 2, Math.abs(z) - D / 2) > pad;
    for (let x = -W / 2 - 30; x <= W / 2 + 30; x += 7 + rnd() * 4) treePts.push([x, -D / 2 - 12 + (rnd() - 0.5) * 3]);
    for (let z = -D / 2 - 30; z <= D / 2 + 8; z += 7 + rnd() * 4) { treePts.push([-W / 2 - 12 + (rnd() - 0.5) * 3, z]); if (rnd() < 0.5) treePts.push([W / 2 + 12 + (rnd() - 0.5) * 3, z]); }
    for (let i = 0; i < 520; i++) {
      const x = (rnd() - 0.5) * 2 * E * 0.8, z = (rnd() - 0.5) * 2 * E * 0.8;
      if (!awayFromFarm(x, z, 40) || Math.abs(z - roadZ) < 10) continue;
      if (noise.fbm(x * 0.006 + 90, z * 0.006 + 40, 2) > -0.05 && rnd() < 0.55) continue;
      treePts.push([x, z]);
    }
    for (let x = -W * 0.9; x <= W * 0.9; x += 28 + rnd() * 14) { if (Math.abs(x - laneX) > 8) palmPts.push([x, roadZ + 8 + rnd() * 3]); }
    for (let i = 0; i < 24; i++) { const x = (rnd() - 0.5) * W * 1.6, z = D / 2 + 28 + rnd() * 80; palmPts.push([x, z]); }
    const placeInst = (geo, pts, minS, maxS) => {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), pts.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const col = new Float32Array(pts.length * 3);
      pts.forEach((pt, i) => {
        const s = lerp(minS, maxS, rnd()); q.setFromAxisAngle(up, rnd() * 6.28); sc.set(s, s * (0.9 + rnd() * 0.25), s); p.set(pt[0], H(pt[0], pt[1]) - 0.1, pt[1]);
        m.compose(p, q, sc); mesh.setMatrixAt(i, m);
        const v = 0.78 + rnd() * 0.4; col[i * 3] = v * (0.9 + rnd() * 0.2); col[i * 3 + 1] = v; col[i * 3 + 2] = v * 0.9;
      });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3); mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false;
      return mesh;
    };
    group.add(placeInst(treeG, treePts, 0.8, 1.7)); group.add(placeInst(palmG, palmPts, 0.9, 1.3));

    // ======================= environment + camera setup =======================
    const fog = scene.fog;
    if (fog) { fog.near = span * 1.25; fog.far = E * 0.85; }
    camera.near = 0.15; camera.far = E * 1.6; camera.updateProjectionMatrix();
    controls.minDistance = 1.2; controls.maxDistance = span * 4.2; controls.zoomSpeed = 2.4; controls.maxPolarAngle = 1.5; controls.screenSpacePanning = false;
    if (ctx.sunLight) { ctx.sunLight.castShadow = false; ctx.sunLight.position.set(span * 0.8, span * 1.1, span * 0.45); ctx.sunLight.target.position.set(0, 0, 0); scene.add(ctx.sunLight.target); }
    if (ctx.hideObjects) ctx.hideObjects.forEach((o) => { if (o) o.visible = false; });
    if (ctx.rain) { const k = Math.max(3, span / 28); ctx.rain.scale.setScalar(k); ctx.rain.material.size = 0.06 * k * 1.1; }
    if (ctx.clouds) { const k = span / 12; ctx.clouds.scale.setScalar(k); ctx.clouds.position.y = span * 0.12; }
    if (ctx.stream) { const k = span / 40; ctx.stream.scale.setScalar(k); ctx.stream.material.size = 0.05 * k; ctx.stream.position.set(0, H(0, 0), 0); }
    if (ctx.ring) { const k = span / 40; ctx.ring.userData.baseScale = k; ctx.ring.scale.setScalar(k); ctx.ring.position.set(0, H(0, 0) + 5.8 * k, 0); }

    // ======================= UI =======================
    const wrap = ctx.wrap;
    let ui = null, levelEl = null, titleEl = null, barEl = null, scEl = null, noteEl = null;
    if (wrap) {
      const old = wrap.querySelector(".ls-ui"); if (old) old.remove();
      ui = document.createElement("div"); ui.className = "ls-ui";
      ui.innerHTML = `
        <div class="ls-top ls-glass"><button data-v="aerial" class="on">AERIAL</button><button data-v="field">FIELD</button><button data-v="crop">CROP</button><button data-x="expand" title="Expand viewport">⛶</button></div>
        <div class="ls-legend ls-glass">
          <div class="t" id="ls-title"></div><div class="bar" id="ls-bar"></div><div class="sc" id="ls-sc"></div>
          <div class="ls-toggle"><button data-m="health" class="on">CROP HEALTH</button><button data-m="water">SOIL WATER</button></div>
          <div class="ls-note" id="ls-note"></div>
        </div>
        <div class="ls-level ls-glass"><div class="ladder"><span data-l="0">REGION</span> › <span data-l="1">FARM</span> › <span data-l="2">FIELD</span> › <span data-l="3">ROW</span> › <span data-l="4">PLANT</span></div><div id="ls-alt"></div></div>`;
      wrap.appendChild(ui);
      titleEl = ui.querySelector("#ls-title"); barEl = ui.querySelector("#ls-bar"); scEl = ui.querySelector("#ls-sc"); noteEl = ui.querySelector("#ls-note"); levelEl = ui.querySelector("#ls-alt");
      ui.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => flyTo(b.dataset.v)));
      ui.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m)));
      ui.querySelector("[data-x]").addEventListener("click", () => {
        const c = ctx.container; if (!c) return;
        const big = c.dataset.expanded === "1";
        if (!c.dataset.h0) c.dataset.h0 = c.style.height || "560px";
        c.style.height = big ? c.dataset.h0 : Math.round(Math.min(window.innerHeight * 0.88, 900)) + "px";
        c.dataset.expanded = big ? "0" : "1";
        window.dispatchEvent(new Event("resize"));
      });
    }
    function legendRefresh() {
      if (!titleEl) return;
      const stops = [];
      if (mode === "water") { for (let w = 0; w <= 150; w += 25) stops.push(cssRGB(waterRamp(w))); }
      else { for (let i = 0; i <= 5; i++) stops.push(cssRGB(healthColor(i / 5, cropLin).map((v) => Math.pow(v, 1 / 2.2)))); }
      barEl.style.background = "linear-gradient(90deg," + stops.join(",") + ")";
      titleEl.textContent = mode === "water" ? "SIMULATED SOIL WATER" : "MODELLED CROP HEALTH";
      scEl.innerHTML = mode === "water" ? "<span>0 mm</span><span>75</span><span>150 mm</span>" : "<span>SEVERE STRESS</span><span>HEALTHY</span>";
      noteEl.textContent = (mode === "water" ? "Soil-water balance from the twin, with modelled variation across the field. " : "Colour follows the twin's water balance and heat stress across the field. ") +
        "Stylised canopy: " + totalInstances.toLocaleString() + " crop tufts" + (kScale > 1.05 ? " (each ≈ " + Math.round(kScale * kScale) + " plants)" : "") + ".";
      if (ui) ui.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
    }

    // ======================= recolouring =======================
    function recolor() {
      const base = baseState.soil_water_mm + deltaMm, heat = !!baseState.heat_stress;
      const lut = new Float32Array(151 * 3);
      for (let w = 0; w <= 150; w++) {
        let hl = healthFromWater(w); if (heat) hl = Math.max(0, hl - 0.12);
        let c = healthColor(hl, cropLin);
        if (mode === "water") c = mixRGB(c, toLin(waterRamp(w)), 0.82);
        lut[w * 3] = c[0]; lut[w * 3 + 1] = c[1]; lut[w * 3 + 2] = c[2];
      }
      tileMeshes.forEach((t) => {
        const arr = t.mesh.instanceColor.array;
        for (let i = 0; i < t.off.length; i++) {
          const w = clamp(Math.round(base + t.off[i]), 0, 150) * 3, v = t.vary[i];
          arr[i * 3] = lut[w] * v; arr[i * 3 + 1] = lut[w + 1] * v; arr[i * 3 + 2] = lut[w + 2] * v;
        }
        t.mesh.instanceColor.needsUpdate = true;
      });
      repaintGround();
    }
    function setMode(m) { mode = m === "water" ? "water" : "health"; legendRefresh(); recolor(); }
    function applyWater(d) { deltaMm = d || 0; recolor(); }
    recolor(); legendRefresh();

    // ======================= views / camera =======================
    function viewFor(name) {
      const A0 = plots[0] || { cx: 0, cz: -D * 0.2 };
      let target, dist, el, az;
      if (name === "field") { target = new THREE.Vector3(A0.cx, H(A0.cx, A0.cz) + 0.5, A0.cz); dist = clamp(cfg.row * kScale * 55, 30, 110); el = 0.38; az = 0.25; }
      else if (name === "crop") { const x = A0.cx + (A0.cx > 1 ? -4 : 3), z = A0.cz + 1; target = new THREE.Vector3(x, H(x, z) + cfg.h * 0.55 * heightScale, z); dist = 2.2 + cfg.h * 1.6; el = 0.26; az = 0.3; }
      else { target = new THREE.Vector3(0, H(0, 0) + 0.5, D * 0.04); dist = span * 1.08; el = 0.62; az = 0.5; }
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      return { target, dir, dist, pos: target.clone().add(dir.clone().multiplyScalar(dist)) };
    }
    let flying = 0;
    function flyTo(name, ms) {
      const v = viewFor(name); ms = ms || 2200;
      const p0 = camera.position.clone(), t0 = controls.target.clone();
      const d0 = p0.clone().sub(t0), l0 = Math.max(0.5, d0.length()), n0 = d0.clone().normalize();
      const token = ++flying; controls.enabled = false;
      const start = performance.now();
      if (ui) ui.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === name));
      (function step(now) {
        if (token !== flying) return;
        const k = Math.min(1, (now - start) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const tg = t0.clone().lerp(v.target, e);
        const dir = n0.clone().lerp(v.dir, e).normalize();
        const dist = Math.exp(lerp(Math.log(l0), Math.log(v.dist), e));
        controls.target.copy(tg); camera.position.copy(tg).add(dir.multiplyScalar(dist)); camera.lookAt(tg);
        if (k < 1) requestAnimationFrame(step); else { controls.enabled = true; controls.update(); }
      })(performance.now());
    }
    function setViewNow(name) { const v = viewFor(name); controls.target.copy(v.target); camera.position.copy(v.pos); camera.lookAt(v.target); controls.update(); }
    setViewNow("aerial");

    // ======================= picking =======================
    function pick(raycaster) {
      const hit = raycaster.intersectObject(groundMesh)[0];
      if (!hit) return null;
      const x = hit.point.x, z = hit.point.z, pl = plotAt(x, z);
      if (!pl) {
        const inFarm = Math.abs(x) <= W / 2 && Math.abs(z) <= D / 2;
        return { area: inFarm ? "Farm infrastructure" : "Surrounding land", water: null };
      }
      const w = clamp(Math.round(baseState.soil_water_mm + deltaMm + waterOffsetAt(x, z, pl)), 0, 150);
      const ca = Math.cos(pl.angle), sa = Math.sin(pl.angle), wl = -(x - pl.cx) * sa + (z - pl.cz) * ca;
      const rowNo = Math.round(wl / pl.row) + pl.nRows + 1;
      return { area: pl.name, water: w, row: rowNo, rows: pl.nRows * 2 + 1 };
    }

    // ======================= per-frame update =======================
    let wind = 0, lastT = 0, slow = 0, frames = 0;
    function update(t, windOn, cam) {
      // safety net: if the machine is struggling, drop render resolution
      const dt = t - lastT; lastT = t; frames++;
      if (frames > 60) { slow = slow * 0.95 + (dt > 0.045 ? 1 : 0) * 0.05; if (slow > 0.6 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); renderer.setSize(ctx.container.clientWidth, ctx.container.clientHeight); slow = 0; } }
      U.uTime.value = t; wind += ((windOn ? 1 : 0) - wind) * 0.04; U.uWind.value = wind;
      const c = cam || camera;
      const gy = H(c.position.x, c.position.z) + 0.7;
      if (c.position.y < gy) c.position.y = gy;
      if (controls.enabled) {
        controls.target.x = clamp(controls.target.x, -W * 0.8, W * 0.8); controls.target.z = clamp(controls.target.z, -D * 0.8, D * 0.8);
      }
      const dist = c.position.distanceTo(controls.target);
      if (controls.enabled) { const ty = H(controls.target.x, controls.target.z) + (dist < 12 ? 0.45 : 0.5); controls.target.y += (ty - controls.target.y) * 0.15; }
      sprites.forEach((s) => { const d = c.position.distanceTo(s.position); s.material.opacity = clamp((d - span * 0.18) / (span * 0.25), 0, 1); s.visible = s.material.opacity > 0.02; });
      if (ctx.rain && ctx.rain.visible) ctx.rain.position.set(controls.target.x, H(controls.target.x, controls.target.z), controls.target.z);
      if (ctx.clouds) { ctx.clouds.position.x = controls.target.x * 0.2; ctx.clouds.position.z = controls.target.z * 0.2; }
      if (levelEl) {
        const lvl = dist > span * 0.95 ? 0 : dist > span * 0.3 ? 1 : dist > 28 ? 2 : dist > 6 ? 3 : 4;
        ui.querySelectorAll(".ladder span").forEach((s) => s.classList.toggle("on", Number(s.dataset.l) === lvl));
        levelEl.innerHTML = "ALT <b>" + Math.max(0, Math.round(c.position.y - H(c.position.x, c.position.z))) + " m</b> · " + areaHa.toFixed(1) + " HA";
      }
    }

    CURRENT = {
      group, span, W, D, areaHa, crop, H, plots, totalInstances, kScale, ui,
      applyWater, pick, update, flyTo, setMode, setViewNow, viewFor,
      get mode() { return mode; },
      dispose() {
        group.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { if (m.map) m.map.dispose(); if (m.alphaMap) m.alphaMap.dispose(); m.dispose(); }); }
        });
        scene.remove(group);
        if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
      },
    };
    return CURRENT;
  }

  function dispose() { if (CURRENT) { CURRENT.dispose(); CURRENT = null; } }

  window.Landscape = {
    build, dispose,
    get current() { return CURRENT; },
    applyWater(d) { if (CURRENT) CURRENT.applyWater(d); },
    pick(r) { return CURRENT ? CURRENT.pick(r) : null; },
    update(t, w, c) { if (CURRENT) CURRENT.update(t, w, c); },
    flyTo(n, ms) { if (CURRENT) CURRENT.flyTo(n, ms); },
    setMode(m) { if (CURRENT) CURRENT.setMode(m); },
  };
})();