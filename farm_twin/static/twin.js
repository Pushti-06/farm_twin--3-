// ---------------------------------------------------------------------------
// Real 3D model preload — a genuine CC0 (public domain) low-poly wheat model
// from Poly Pizza, used as the base mesh for every crop (color/scale-adjusted
// per crop). Falls back to procedural geometry automatically if this fails
// to load for any reason, so the demo never breaks.
// ---------------------------------------------------------------------------

const WHEAT_MODEL_URL = "https://static.poly.pizza/799054f9-931b-4c31-8811-b5199bf94e59.glb";
let plantModelTemplate = null;

function preloadModels() {
  return new Promise((resolve) => {
    if (typeof THREE.GLTFLoader === "undefined") {
      resolve();
      return;
    }
    const loader = new THREE.GLTFLoader();
    const timeout = setTimeout(() => resolve(), 4000); // never block the page more than 4s
    loader.load(
      WHEAT_MODEL_URL,
      (gltf) => {
        clearTimeout(timeout);
        plantModelTemplate = gltf.scene;
        resolve();
      },
      undefined,
      (err) => {
        clearTimeout(timeout);
        console.warn("Real 3D plant model failed to load, using procedural plants instead.", err);
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Page load: fetch twin state and render everything
// ---------------------------------------------------------------------------

async function loadTwinState() {
  const res = await fetch("/api/twin-state");
  const data = await res.json();

  const noData = document.getElementById("no-data");
  const content = document.getElementById("twin-content");

  if (!data.ready) {
    noData.style.display = "block";
    content.style.display = "none";
    return;
  }

  noData.style.display = "none";
  content.style.display = "block";

  const badge = document.getElementById("fiware-badge");
  if (data.fiware_source === "orion") {
    badge.className = "notice good";
    badge.textContent = "● Connected to FIWARE Orion Context Broker — this state was just read live from Orion, entity: " + data.fiware_entity_id;
  } else {
    badge.className = "notice warn";
    badge.textContent = "○ FIWARE Orion not reachable — showing the locally computed twin state instead. Run docker-compose up -d to connect it.";
  }
  badge.style.display = "block";

  const twin = data.twin_state;
  document.getElementById("twin-status").textContent = twin.status;
  document.getElementById("twin-updated").textContent = "Updated " + data.updated_at;
  document.getElementById("soil-water").textContent = twin.soil_water_mm;
  document.getElementById("dry-days").textContent = twin.consecutive_dry_days;

  const statusCard = document.getElementById("status-card");
  statusCard.style.borderLeft =
    twin.status === "Healthy" ? "4px solid #2F8F5B" :
    (twin.drought_risk && twin.heat_stress) ? "4px solid #C24A4A" : "4px solid #C98A2B";

  document.getElementById("water-bar-fill").style.width = twin.soil_water_fill_pct + "%";

  const weather = data.recent_weather;
  Plotly.newPlot("weather-chart", [
    {
      x: weather.map(d => d.date), y: weather.map(d => d.temp_max),
      name: "Max Temp (°C)", type: "scatter", mode: "lines+markers",
      line: { color: "#C98A2B", width: 2 },
    },
    {
      x: weather.map(d => d.date), y: weather.map(d => d.precipitation),
      name: "Rainfall (mm)", type: "bar", yaxis: "y2",
      marker: { color: "#4B90D6" },
    },
  ], {
    margin: { t: 10, r: 50, l: 50, b: 60 },
    height: 300,
    yaxis: { title: "Max Temp (°C)" },
    yaxis2: { title: "Rainfall (mm)", overlaying: "y", side: "right" },
    legend: { orientation: "h", y: 1.15 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
  }, { displayModeBar: false, responsive: true });

  Plotly.newPlot("water-chart", [{
    x: data.twin_history.map(d => d.date),
    y: data.twin_history.map(d => d.soil_water_mm),
    type: "scatter", mode: "lines+markers",
    line: { color: "#2F8F5B", width: 3 },
    fill: "tozeroy", fillcolor: "rgba(47,143,91,0.1)",
  }], {
    margin: { t: 10, r: 10, l: 50, b: 60 },
    height: 260,
    yaxis: { title: "Soil Water (mm)", range: [0, 150] },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
  }, { displayModeBar: false, responsive: true });

  const trajectory = data.yield_trajectory || [];
  if (trajectory.length > 0) {
    Plotly.newPlot("yield-trajectory-chart", [{
      x: trajectory.map(d => d.date),
      y: trajectory.map(d => d.projected_yield_kg_per_ha),
      type: "scatter", mode: "lines+markers",
      line: { color: "#C98A2B", width: 3 },
      fill: "tozeroy", fillcolor: "rgba(201,138,43,0.1)",
    }], {
      margin: { t: 10, r: 10, l: 60, b: 60 },
      height: 260,
      yaxis: { title: "Projected Yield (kg/ha)" },
      paper_bgcolor: "white",
      plot_bgcolor: "white",
    }, { displayModeBar: false, responsive: true });
  }

  renderField(data.crop, data.area, twin);
  setupWhatIfSlider();
  applyLiveConditions(data);
  renderSatelliteSnapshot(data);
}

// ---------------------------------------------------------------------------
// Real satellite imagery of the exact farm coordinates — no API key needed,
// uses ESRI's public World Imagery tile service. This is the actual real
// place, not a reconstruction — the 3D simulation below models what's
// growing there, grounded in this genuine location.
// ---------------------------------------------------------------------------

function lonToTileX(lon, zoom) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}

function latToTileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

function renderSatelliteSnapshot(data) {
  const panel = document.getElementById("satellite-panel");
  const grid = document.getElementById("satellite-grid");
  const caption = document.getElementById("satellite-caption");
  const lat = data.farm_lat, lon = data.farm_lon;

  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    panel.style.display = "none";
    return;
  }

  const zoom = 17;
  const centerX = lonToTileX(lon, zoom);
  const centerY = latToTileY(lat, zoom);

  grid.innerHTML = "";
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const img = document.createElement("img");
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${centerY + dy}/${centerX + dx}`;
      img.loading = "lazy";
      img.alt = "Satellite tile";
      grid.appendChild(img);
    }
  }

  const reticle = document.createElement("div");
  reticle.className = "reticle";
  reticle.innerHTML = `
    <div class="reticle-ring reticle-ring-outer"></div>
    <div class="reticle-ring reticle-ring-mid"></div>
    <div class="reticle-cross reticle-cross-h"></div>
    <div class="reticle-cross reticle-cross-v"></div>
    <div class="reticle-dot"></div>
  `;
  grid.appendChild(reticle);

  const readout = document.getElementById("hud-readout");
  readout.textContent =
    `LAT  ${lat.toFixed(5)}\n` +
    `LON  ${lon.toFixed(5)}\n` +
    `ZOOM ${zoom}  ·  STATUS: LOCKED`;

  caption.textContent = data.used_exact_location
    ? `Real satellite imagery for ${data.location_label} — the marker shows your farm's exact coordinates (${lat.toFixed(4)}, ${lon.toFixed(4)}).`
    : `Showing ${data.location_label} as an approximation, not your exact farm — enter your village/town on the Dashboard for the real spot.`;

  panel.style.display = "block";
}

// ---------------------------------------------------------------------------
// Auto-detect the real current weather condition and apply it to the scene
// ---------------------------------------------------------------------------

function detectCondition(weatherCode, windSpeed, tempMax, precipitation) {
  const stormCodes = [95, 96, 99];                                   // thunderstorm
  const rainCodes = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]; // drizzle/rain/showers
  const cloudyCodes = [1, 2, 3, 45, 48];                              // partly cloudy/overcast/fog
  if (stormCodes.includes(weatherCode)) return "storm";
  if (rainCodes.includes(weatherCode)) return "rain";
  // even if the categorical code says just "cloudy", real measurable rain right now wins —
  // this catches light/patchy rain that the coarser weather_code sometimes under-reports
  if (precipitation !== null && precipitation !== undefined && precipitation > 0.1) return "rain";
  if (windSpeed !== null && windSpeed !== undefined && windSpeed >= 25) return "storm";
  if (tempMax !== null && tempMax !== undefined && tempMax >= 35) return "heat";
  if (cloudyCodes.includes(weatherCode)) return "cloudy";
  return "clear";
}

function applyLiveConditions(data) {
  const cw = data.current_weather || {};
  const condition = detectCondition(cw.weather_code, cw.wind_speed, cw.temp_max, cw.precipitation);
  applyPreset(condition);

  const label = document.getElementById("live-condition-label");
  const p = PRESETS[condition];
  const tempTxt = cw.temperature !== null && cw.temperature !== undefined ? `${cw.temperature}°C` : "—";
  const humTxt = cw.humidity !== null && cw.humidity !== undefined ? `${cw.humidity}%` : "—";
  const windTxt = cw.wind_speed !== null && cw.wind_speed !== undefined ? `${cw.wind_speed} km/h` : "—";
  const place = data.location_label || data.district;
  const precisionNote = data.used_exact_location ? "" : " (enter an exact village/town on the Dashboard for local accuracy)";
  label.textContent = `🌍 Live conditions at ${place}${precisionNote}: ${p.label} · ${tempTxt}, ${humTxt} humidity, ${windTxt} wind — auto-loaded from real current weather (updated ${data.updated_at}).`;
}

// ---------------------------------------------------------------------------
// 3D field visualization
// ---------------------------------------------------------------------------

const CROP_STYLES = {
  RICE: { height: 0.35, leafColor: 0x7CB86F, leafCount: 6, fruit: false },
  WHEAT: { height: 0.6, leafColor: 0xD4B45A, leafCount: 3, fruit: false, grain: true },
  MAIZE: { height: 1.1, leafColor: 0x5A9E4E, leafCount: 6, fruit: false, cob: true },
  SUGARCANE: { height: 1.7, leafColor: 0x4F9450, leafCount: 4, fruit: false },
  COTTON: { height: 0.5, leafColor: 0x6BA860, leafCount: 6, fruit: true, fruitColor: 0xFFFFFF, ripens: false },
  GROUNDNUT: { height: 0.22, leafColor: 0x5C9A55, leafCount: 8, fruit: false },
  SOYABEAN: { height: 0.3, leafColor: 0x62A05A, leafCount: 7, fruit: true, fruitColor: 0x8FBF5A, ripens: false },
};

const DROUGHT_THRESHOLD_MM = 40.0;
const CAPACITY_MM = 150.0;

let twinScene, twinCamera, twinRenderer, twinControls, twinContainer, twinAnimating = false;
let raycaster, mouse, rainParticles, sunLight;
let PLANT_GROUPS = [];
let BASE_TWIN_STATE = null;
let windActive = false;
let clock;

// viewport height follows the container (so the "expand" button works)
function twinH() { return (twinContainer && twinContainer.clientHeight) || 560; }

// sky colour helper: background is a raw colour, fog needs linear so the horizon blends seamlessly
function setSky(hex) {
  twinScene.background.setHex(hex);
  twinScene.fog.color.setHex(hex);
  twinScene.fog.color.convertSRGBToLinear();
}

function statusForWater(waterMm, heatStress) {
  const drought = waterMm < DROUGHT_THRESHOLD_MM;
  if (drought && heatStress) return { label: "Critical", tone: "critical" };
  if (drought) return { label: "Water-stressed", tone: "warn" };
  if (heatStress) return { label: "Heat-stressed", tone: "warn" };
  return { label: "Healthy", tone: "good" };
}

function tintForStatus(tone) {
  if (tone === "critical") return { r: 0.85, g: 0.55, b: 0.35 };
  if (tone === "warn") return { r: 0.85, g: 0.72, b: 0.4 };
  return { r: 1, g: 1, b: 1 };
}

function tintColor(hex, tint) {
  const r = ((hex >> 16) & 0xff) * tint.r;
  const g = ((hex >> 8) & 0xff) * tint.g;
  const b = (hex & 0xff) * tint.b;
  return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}

function initTwinScene() {
  twinContainer = document.getElementById("twin-3d-container");
  if (!twinContainer || twinScene) return;

  twinScene = new THREE.Scene();
  // sky gradient instead of flat color
  const skyColor = new THREE.Color(0xBFE0F0);
  const groundColor = new THREE.Color(0xF6FAF6);
  twinScene.background = skyColor;
  twinScene.fog = new THREE.Fog(0xBFE0F0, 12, 26);

  twinCamera = new THREE.PerspectiveCamera(45, twinContainer.clientWidth / twinH(), 0.1, 1000);
  twinCamera.position.set(7, 5.5, 9);

  twinRenderer = new THREE.WebGLRenderer({ antialias: true });
  twinRenderer.setSize(twinContainer.clientWidth, twinH());
  twinRenderer.setPixelRatio(window.devicePixelRatio);
  twinRenderer.shadowMap.enabled = true;
  twinRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  twinRenderer.outputEncoding = THREE.sRGBEncoding;
  twinRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  twinRenderer.toneMappingExposure = 1.15;
  twinContainer.appendChild(twinRenderer.domElement);

  twinControls = new THREE.OrbitControls(twinCamera, twinRenderer.domElement);
  twinControls.target.set(0, 0.5, 0);
  twinControls.enableDamping = true;
  twinControls.dampingFactor = 0.08;
  twinControls.minDistance = 4;
  twinControls.maxDistance = 20;
  twinControls.maxPolarAngle = Math.PI / 2.05; // don't let camera go under the ground

  twinScene.add(new THREE.HemisphereLight(skyColor, groundColor, 0.6));
  sunLight = new THREE.DirectionalLight(0xFFF6E0, 1.0);
  sunLight.position.set(8, 12, 6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -10;
  sunLight.shadow.camera.right = 10;
  sunLight.shadow.camera.top = 10;
  sunLight.shadow.camera.bottom = -10;
  twinScene.add(sunLight);

  createRain();
  createClouds();
  createHoloGrid();
  createContainmentDome();
  createDataStream();

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  clock = new THREE.Clock();
  twinRenderer.domElement.addEventListener("click", onFieldClick);
  twinRenderer.domElement.style.cursor = "pointer";

  window.addEventListener("resize", () => {
    if (!twinContainer) return;
    twinCamera.aspect = twinContainer.clientWidth / twinH();
    twinCamera.updateProjectionMatrix();
    twinRenderer.setSize(twinContainer.clientWidth, twinH());
  });

  if (!twinAnimating) {
    twinAnimating = true;
    (function animate() {
      requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

      if (windActive) {
        PLANT_GROUPS.forEach((plant, idx) => {
          const sway = Math.sin(elapsed * 3 + idx * 0.7) * 0.12 + Math.sin(elapsed * 7 + idx) * 0.04;
          plant.rotation.z = sway;
          plant.rotation.x = sway * 0.4;
        });
      } else {
        PLANT_GROUPS.forEach((plant) => {
          plant.rotation.z *= 0.9;
          plant.rotation.x *= 0.9;
        });
      }

      if (rainParticles && rainParticles.visible) {
        const pos = rainParticles.geometry.attributes.position.array;
        for (let i = 1; i < pos.length; i += 3) {
          pos[i] -= 0.25;
          if (pos[i] < 0) pos[i] = 8 + Math.random() * 2;
        }
        rainParticles.geometry.attributes.position.needsUpdate = true;
      }

      if (cloudGroup && cloudGroup.visible) {
        cloudGroup.children.forEach((cloud, idx) => {
          cloud.position.x += (windActive ? 0.02 : 0.006) * (1 + idx % 3 * 0.3);
          if (cloud.position.x > 9) cloud.position.x = -9;
        });
      }

      if (holoGrid) {
        holoGrid.material.opacity = 0.35 + Math.sin(elapsed * 1.5) * 0.1;
      }

      if (dataStream) {
        const pos = dataStream.geometry.attributes.position.array;
        for (let i = 1; i < pos.length; i += 3) {
          pos[i] += 0.04;
          if (pos[i] > 5.6) pos[i] = 0.3;
        }
        dataStream.geometry.attributes.position.needsUpdate = true;
      }

      if (telemetryRing) {
        telemetryRing.rotation.z = elapsed * 0.6;
        telemetryRing.scale.setScalar((telemetryRing.userData.baseScale || 1) * (1 + Math.sin(elapsed * 2) * 0.06));
      }

      if (containmentDome) {
        containmentDome.rotation.y = elapsed * 0.03;
      }

      if (window.Landscape && window.Landscape.current) window.Landscape.update(elapsed, windActive, twinCamera);
      twinControls.update();
      twinRenderer.render(twinScene, twinCamera);
    })();
  }
}

function createRain() {
  const count = 500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 1] = Math.random() * 8;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 16;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const rainMat = new THREE.PointsMaterial({ color: 0x9FC5E8, size: 0.06, transparent: true, opacity: 0.7 });
  rainParticles = new THREE.Points(rainGeo, rainMat);
  rainParticles.visible = false;
  twinScene.add(rainParticles);
}

let cloudGroup;
let holoGrid, containmentDome, dataStream, telemetryRing;

function createHoloGrid() {
  // a glowing cyan scan-grid on the ground — classic "digital twin" HUD look
  holoGrid = new THREE.GridHelper(14, 28, 0x4FD1E8, 0x2F8F9E);
  holoGrid.position.y = 0.02;
  holoGrid.material.transparent = true;
  holoGrid.material.opacity = 0.4;
  twinScene.add(holoGrid);
}

function createContainmentDome() {
  // a translucent "digital containment field" dome over the whole farm —
  // signals "this is a live-monitored virtual space", not a literal object
  const domeGeo = new THREE.SphereGeometry(7.5, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeMat = new THREE.MeshBasicMaterial({
    color: 0x4FD1E8, transparent: true, opacity: 0.05,
    side: THREE.DoubleSide, wireframe: false,
  });
  containmentDome = new THREE.Mesh(domeGeo, domeMat);
  twinScene.add(containmentDome);

  const wireGeo = new THREE.SphereGeometry(7.52, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x4FD1E8, wireframe: true, transparent: true, opacity: 0.15 });
  const wireDome = new THREE.Mesh(wireGeo, wireMat);
  containmentDome.add(wireDome);
}

function createDataStream() {
  // glowing particles rising from the field toward a telemetry ring above —
  // visualizes live data flowing up to FIWARE/the cloud
  const count = 60;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.8;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = Math.random() * 5.6;
    positions[i * 3 + 2] = Math.sin(angle) * r;
  }
  const streamGeo = new THREE.BufferGeometry();
  streamGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const streamMat = new THREE.PointsMaterial({ color: 0x4FD1E8, size: 0.05, transparent: true, opacity: 0.85 });
  dataStream = new THREE.Points(streamGeo, streamMat);
  twinScene.add(dataStream);

  const ringGeo = new THREE.TorusGeometry(0.9, 0.03, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x4FD1E8, transparent: true, opacity: 0.8 });
  telemetryRing = new THREE.Mesh(ringGeo, ringMat);
  telemetryRing.position.y = 5.8;
  telemetryRing.rotation.x = Math.PI / 2;
  twinScene.add(telemetryRing);
}

function createClouds() {
  cloudGroup = new THREE.Group();
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 1, transparent: true, opacity: 0.85 });
  const puffCount = 6;
  for (let c = 0; c < puffCount; c++) {
    const cloud = new THREE.Group();
    const blobCount = 4 + Math.floor(Math.random() * 3);
    for (let b = 0; b < blobCount; b++) {
      const blob = new THREE.Mesh(new THREE.SphereGeometry(0.6 + Math.random() * 0.4, 8, 8), cloudMat);
      blob.position.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.2);
      blob.scale.y = 0.6;
      cloud.add(blob);
    }
    cloud.position.set((Math.random() - 0.5) * 14, 6.5 + Math.random() * 1.5, (Math.random() - 0.5) * 14);
    cloudGroup.add(cloud);
  }
  cloudGroup.visible = false;
  twinScene.add(cloudGroup);
}

function clearFieldGroup() {
  const existing = twinScene.getObjectByName("field-group");
  if (existing) twinScene.remove(existing);
  PLANT_GROUPS = [];
}

function makeLeafGeometry(length, width) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(width, length * 0.4, 0, length);
  shape.quadraticCurveTo(-width, length * 0.4, 0, 0);
  return new THREE.ShapeGeometry(shape);
}

let groundTexture;

function createGroundTexture() {
  if (groundTexture) return groundTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#B99B6E";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2200; i++) {
    const shade = 150 + Math.floor(Math.random() * 70);
    ctx.fillStyle = `rgba(${shade}, ${shade - 30}, ${shade - 70}, 0.5)`;
    const x = Math.random() * 256, y = Math.random() * 256;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  groundTexture = new THREE.CanvasTexture(canvas);
  groundTexture.wrapS = THREE.RepeatWrapping;
  groundTexture.wrapT = THREE.RepeatWrapping;
  return groundTexture;
}

function createGlowSprite(hexColor, size) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const c = new THREE.Color(hexColor);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  gradient.addColorStop(0, `rgba(${rgb},0.9)`);
  gradient.addColorStop(0.4, `rgba(${rgb},0.35)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

function renderField(crop, areaHectares, twinState) {
  initTwinScene();
  clearFieldGroup();
  BASE_TWIN_STATE = twinState;

  // Landscape mode: a large, area-scaled agricultural landscape with instanced
  // crop rows. If anything goes wrong we fall back to the original plant grid below.
  if (window.Landscape) {
    try {
      window.Landscape.build({
        scene: twinScene, camera: twinCamera, controls: twinControls, renderer: twinRenderer,
        crop, areaHa: areaHectares, twinState, sunLight,
        wrap: document.getElementById("twin-3d-wrap"), container: twinContainer,
        rain: rainParticles, clouds: cloudGroup, stream: dataStream, ring: telemetryRing,
        hideObjects: [containmentDome, holoGrid],
        locKey: (window.__TWIN_LOC_KEY || ""),
      });
      setSky(twinScene.background.getHex());
      applyWaterLevel(0);
      return;
    } catch (err) {
      console.error("Landscape build failed, using the original plant grid instead:", err);
      window.Landscape.dispose();
      [containmentDome, holoGrid].forEach((o) => { if (o) o.visible = true; });
    }
  }

  const style = CROP_STYLES[crop] || CROP_STYLES.RICE;

  // area now genuinely changes the field size — a 2 ha field looks visibly
  // different from a 10 ha field, both in plant count and camera framing
  const gridSize = Math.max(4, Math.min(24, Math.round(Math.sqrt(areaHectares) * 5) + 3));
  const spacing = 0.55;
  const fieldSpan = gridSize * spacing;

  // camera dollies out for bigger fields instead of staying fixed
  const camDist = Math.max(9, fieldSpan * 1.35 + 3);
  twinCamera.position.set(camDist * 0.62, camDist * 0.5, camDist * 0.78);
  twinControls.maxDistance = camDist * 2.2;

  // scale the holographic elements to match this field's actual footprint
  const sceneScale = fieldSpan / 9;
  if (containmentDome) containmentDome.scale.setScalar(sceneScale);
  if (holoGrid) holoGrid.scale.setScalar(sceneScale);
  if (dataStream) dataStream.scale.set(sceneScale, 1, sceneScale);
  if (telemetryRing) telemetryRing.scale.set(sceneScale, sceneScale, 1);

  const fieldGroup = new THREE.Group();
  fieldGroup.name = "field-group";

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(fieldSpan + 1, fieldSpan + 1, 1, 1),
    new THREE.MeshStandardMaterial({ map: createGroundTexture(), roughness: 1 })
  );
  ground.material.map.repeat.set(fieldSpan / 2, fieldSpan / 2);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  fieldGroup.add(ground);

  const glow = createGlowSprite(0x4FD1E8, 1.4 * sceneScale);
  glow.position.set(0, 5.8, 0);
  fieldGroup.add(glow);

  const leafGeo = makeLeafGeometry(0.22, 0.07);

  // fewer sub-meshes per plant as the field gets bigger, so large farms
  // (up to 24x24 = 576 plants) still render smoothly
  const detailScale = gridSize > 16 ? 0.6 : gridSize > 10 ? 0.8 : 1.0;

  let plantId = 0;
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const x = (i - gridSize / 2) * spacing + (Math.random() - 0.5) * 0.1;
      const z = (j - gridSize / 2) * spacing + (Math.random() - 0.5) * 0.1;

      if (plantModelTemplate) {
        // real 3D model path — clone the loaded CC0 model, auto-scale it to
        // this crop's height using its actual bounding box, and capture each
        // mesh's original color so health-tinting can multiply it later
        // instead of replacing it (keeps the model's natural coloring)
        const instance = plantModelTemplate.clone(true);
        instance.traverse((child) => {
          if (child.isMesh) {
            child.material = child.material.clone();
            child.castShadow = true;
          }
        });

        const rawBox = new THREE.Box3().setFromObject(instance);
        const rawHeight = rawBox.max.y - rawBox.min.y;
        const scaleFactor = rawHeight > 0.001 ? style.height / rawHeight : 1;
        instance.scale.setScalar(scaleFactor);

        const groundedBox = new THREE.Box3().setFromObject(instance);
        instance.position.set(x, -groundedBox.min.y, z);
        instance.rotation.y = Math.random() * Math.PI * 2;

        const originalColors = [];
        instance.traverse((child) => {
          if (child.isMesh && child.material && child.material.color) {
            originalColors.push({ material: child.material, base: child.material.color.clone() });
          }
        });

        instance.userData = {
          plantId: plantId++,
          jitter: (Math.random() - 0.5) * 30,
          originalColors, style, isModelPlant: true,
        };
        fieldGroup.add(instance);
        PLANT_GROUPS.push(instance);
        continue;
      }

      // procedural fallback — used if the real 3D model couldn't load
      const plantGroup = new THREE.Group();
      const leafMat = new THREE.MeshStandardMaterial({
        color: style.leafColor, roughness: 0.6, side: THREE.DoubleSide,
      });
      const stemMat = new THREE.MeshStandardMaterial({ color: 0x4A6B3E, roughness: 0.8 });

      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.025, style.height, 6), stemMat);
      stem.position.y = style.height / 2;
      stem.castShadow = true;
      plantGroup.add(stem);

      // leaves fan out from partway up the stem
      const leafCount = Math.max(3, Math.round((style.leafCount || 5) * detailScale));
      for (let l = 0; l < leafCount; l++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        const angle = (l / leafCount) * Math.PI * 2 + Math.random() * 0.4;
        const heightFrac = 0.4 + (l % 3) * 0.15;
        leaf.position.set(0, style.height * heightFrac, 0);
        leaf.rotation.y = angle;
        leaf.rotation.z = -0.9 - Math.random() * 0.3;
        leaf.scale.setScalar(style.height * (0.9 + Math.random() * 0.3));
        leaf.castShadow = true;
        plantGroup.add(leaf);
      }

      // extra foliage puffs layered in for a fuller, bushier silhouette
      const puffCount = Math.max(2, Math.round((3 + Math.floor(leafCount / 3)) * detailScale));
      for (let p = 0; p < puffCount; p++) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(0.07 + Math.random() * 0.05, 6, 6),
          leafMat
        );
        puff.position.set(
          (Math.random() - 0.5) * 0.18,
          style.height * (0.45 + Math.random() * 0.45),
          (Math.random() - 0.5) * 0.18
        );
        puff.castShadow = true;
        plantGroup.add(puff);
      }

      // fruit / cob / grain accents, colored by crop, tinted by real health at paint time
      const accents = [];
      if (style.fruit || style.cob || style.grain) {
        const accentCount = style.cob ? 1 : 3;
        for (let a = 0; a < accentCount; a++) {
          const accentGeo = style.cob
            ? new THREE.CylinderGeometry(0.035, 0.03, 0.14, 8)
            : new THREE.SphereGeometry(0.035, 8, 8);
          const accentMat = new THREE.MeshStandardMaterial({ roughness: 0.4 });
          const accent = new THREE.Mesh(accentGeo, accentMat);
          const angle = Math.random() * Math.PI * 2;
          const r = 0.06 + Math.random() * 0.05;
          accent.position.set(
            Math.cos(angle) * r,
            style.height * (0.5 + Math.random() * 0.3),
            Math.sin(angle) * r
          );
          accent.castShadow = true;
          plantGroup.add(accent);
          accents.push(accentMat);
        }
      }

      plantGroup.position.set(x, 0, z);
      plantGroup.userData = {
        plantId: plantId++,
        jitter: (Math.random() - 0.5) * 30,
        leafMat, accents, style, isModelPlant: false,
      };
      fieldGroup.add(plantGroup);
      PLANT_GROUPS.push(plantGroup);
    }
  }

  twinScene.add(fieldGroup);
  twinControls.target.set(0, style.height / 2, 0);

  applyWaterLevel(0);
}

function applyWaterLevel(deltaMm) {
  if (!BASE_TWIN_STATE) return;
  if (window.Landscape && window.Landscape.current) { window.Landscape.applyWater(deltaMm); return; }
  PLANT_GROUPS.forEach((plant) => {
    const water = Math.max(0, Math.min(CAPACITY_MM, BASE_TWIN_STATE.soil_water_mm + plant.userData.jitter + deltaMm));
    const status = statusForWater(water, BASE_TWIN_STATE.heat_stress);
    const tint = tintForStatus(status.tone);
    const style = plant.userData.style;

    if (plant.userData.isModelPlant) {
      // real 3D model — multiply each mesh's ORIGINAL color by the health
      // tint, instead of replacing it, so the model's natural coloring
      // (golden grain heads, green stem, etc.) is preserved under stress
      plant.userData.originalColors.forEach(({ material, base }) => {
        material.color.copy(base).multiply(new THREE.Color(tint.r, tint.g, tint.b));
      });
    } else {
      plant.userData.leafMat.color.setHex(tintColor(style.leafColor, tint));
      // fruit/cob/grain "ripen" with health — full natural color when healthy,
      // duller and browner when the plant is water- or heat-stressed
      const baseAccentColor = style.cob ? 0xE8C34A : (style.fruitColor || 0xFFFFFF);
      const ripeTint = status.tone === "good" ? { r: 1, g: 1, b: 1 } : tint;
      plant.userData.accents.forEach((mat) => {
        mat.color.setHex(tintColor(baseAccentColor, ripeTint));
      });
    }

    plant.userData.currentWater = Math.round(water);
    plant.userData.currentStatus = status.label;
  });
}

function findPlantGroup(obj) {
  let cur = obj;
  while (cur && !PLANT_GROUPS.includes(cur)) cur = cur.parent;
  return cur;
}

function onFieldClick(event) {
  const rect = twinRenderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, twinCamera);

  if (window.Landscape && window.Landscape.current) {
    const popupL = document.getElementById("plant-popup");
    const info = window.Landscape.pick(raycaster);
    if (!info) { popupL.style.display = "none"; return; }
    const wrapRectL = document.getElementById("twin-3d-wrap").getBoundingClientRect();
    popupL.style.left = (event.clientX - wrapRectL.left + 14) + "px";
    popupL.style.top = (event.clientY - wrapRectL.top - 10) + "px";
    if (info.water === null) {
      popupL.innerHTML = `<b>${info.area}</b>`;
    } else {
      const st = statusForWater(info.water, BASE_TWIN_STATE.heat_stress);
      popupL.innerHTML = `
        <b>${info.area} · row ${info.row} of ${info.rows}</b>
        <div class="row"><span>Simulated soil water</span><span>${info.water} mm</span></div>
        <div class="row"><span>Modelled crop health</span><span>${st.label}</span></div>`;
    }
    popupL.style.display = "block";
    return;
  }

  const meshes = [];
  PLANT_GROUPS.forEach(g => g.traverse(c => { if (c.isMesh) meshes.push(c); }));
  const hits = raycaster.intersectObjects(meshes);

  const popup = document.getElementById("plant-popup");
  if (hits.length === 0) {
    popup.style.display = "none";
    return;
  }

  const plant = findPlantGroup(hits[0].object);
  if (!plant) {
    popup.style.display = "none";
    return;
  }
  const wrapRect = document.getElementById("twin-3d-wrap").getBoundingClientRect();
  popup.style.left = (event.clientX - wrapRect.left + 14) + "px";
  popup.style.top = (event.clientY - wrapRect.top - 10) + "px";
  popup.innerHTML = `
    <b>Plant #${plant.userData.plantId}</b>
    <div class="row"><span>Simulated soil water</span><span>${plant.userData.currentWater} mm</span></div>
    <div class="row"><span>Status</span><span>${plant.userData.currentStatus}</span></div>
  `;
  popup.style.display = "block";
}

// ---------------------------------------------------------------------------
// Weather event presets + fine-tune slider
// ---------------------------------------------------------------------------

const PRESETS = {
  clear: { delta: 0, wind: false, sky: 0xBFE0F0, sun: 1.0, rain: false, clouds: false, label: "Clear skies" },
  cloudy: { delta: 10, wind: false, sky: 0x9FAEB5, sun: 0.55, rain: false, clouds: true, label: "Overcast / cloudy" },
  rain: { delta: 55, wind: false, sky: 0x7C93A3, sun: 0.5, rain: true, clouds: true, label: "Heavy rain" },
  storm: { delta: -8, wind: true, sky: 0x9AA79E, sun: 0.7, rain: false, clouds: true, label: "Windstorm" },
  heat: { delta: -45, wind: false, sky: 0xF0C88A, sun: 1.2, rain: false, clouds: false, label: "Heatwave" },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p || !BASE_TWIN_STATE) return;

  document.getElementById("rainfall-slider").value = p.delta;
  document.getElementById("whatif-value").textContent = (p.delta >= 0 ? "+" : "") + p.delta + " mm";
  applyWaterLevel(p.delta);

  windActive = p.wind;
  rainParticles.visible = p.rain;
  cloudGroup.visible = p.clouds;
  setSky(p.sky);
  sunLight.intensity = p.sun;

  document.querySelectorAll(".preset-btn").forEach((b) => b.classList.toggle("active", b.dataset.preset === name));
  document.getElementById("plant-popup").style.display = "none";
}

function setupWhatIfSlider() {
  const slider = document.getElementById("rainfall-slider");
  const label = document.getElementById("whatif-value");
  const resetBtn = document.getElementById("reset-whatif");
  if (!slider || slider.dataset.bound) return; // avoid double-binding on repeated loads
  slider.dataset.bound = "true";

  slider.addEventListener("input", () => {
    const val = parseInt(slider.value, 10);
    label.textContent = (val >= 0 ? "+" : "") + val + " mm";
    applyWaterLevel(val);
    // manual fine-tuning drops out of a named preset back to clear conditions
    windActive = false;
    rainParticles.visible = false;
    cloudGroup.visible = false;
    setSky(PRESETS.clear.sky);
    sunLight.intensity = PRESETS.clear.sun;
    document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("plant-popup").style.display = "none";
  });

  resetBtn.addEventListener("click", () => applyPreset("clear"));

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });
}

preloadModels().then(loadTwinState);