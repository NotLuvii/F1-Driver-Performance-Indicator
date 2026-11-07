/* 3D onboard view: the circuit built at real scale from its outline, every car placed from the
 * replay timeline, and a camera mounted on whichever car you pick (T-cam, cockpit, chase or
 * trackside TV). Loaded on demand by replay.js; needs WebGL. */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const TYRE_HEX = { S: "#e1261c", M: "#f2c200", H: "#ececec", I: "#2bb673", W: "#2a78d6" };
const TYRE_NAME = { S: "Soft", M: "Medium", H: "Hard", I: "Intermediate", W: "Full wet" };
const FIELD_LIVERIES = ["#9aa0a8", "#1f3a5f", "#7a1f2b", "#2d6a4f", "#d9822b", "#5e548e", "#e9e4d4",
  "#3d405b", "#4f9d8b", "#c9a227", "#6b4226", "#2e86ab"];
const HELMETS = ["#f2c200", "#ffffff", "#e1261c", "#2bb673", "#ff7a00", "#9b5de5", "#00bbf9", "#f15bb5"];
const BOARD_COLORS = ["#e8e8e8", "#2a5db0", "#e8e8e8", "#c0392b", "#f2c200", "#e8e8e8", "#1d1d1f", "#2bb673"];
export const shortName = (info) => (info.car ? info.name.split(" ").slice(-1)[0] : info.name.replace("Field car", "Field"));
export const CAMERAS = [["tcam", "T-cam"], ["cockpit", "Cockpit"], ["chase", "Chase"], ["tv", "TV"]];
const ROAD_HALF = 6.2;

const hash = (s) => { let x = 2166136261; for (const ch of String(s)) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let carScenePromise = null;
function loadCar() {
  if (!carScenePromise) carScenePromise = new GLTFLoader().loadAsync("models/car.glb").then((g) => g.scene);
  return carScenePromise;
}

function canvasTexture(w, h, paint, { clampS = false } = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function speckle(g, w, h, n, colors, size) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.fillRect(Math.random() * w, Math.random() * h, size * Math.random() + 1, size * Math.random() + 1);
  }
}

// ---------------------------------------------------------------- the circuit
class Track3D {
  constructor(circuit, meta) {
    const P2 = circuit.points, n2 = P2.length;
    let per = 0;
    for (let i = 0; i < n2; i++) { const a = P2[i], b = P2[(i + 1) % n2]; per += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    this.length = circuit.length_m || 5000;
    const k = this.length / per;
    const curve = new THREE.CatmullRomCurve3(P2.map((p) => new THREE.Vector3(p[0] * k, 0, p[1] * k)), true, "centripetal");
    const N = Math.max(900, Math.round(this.length / 3));
    const P = curve.getSpacedPoints(N); P.pop();
    this.N = N; this.ds = this.length / N; this.P = P;
    this.T = []; this.Lf = [];
    for (let i = 0; i < N; i++) {
      const t = P[(i + 1) % N].clone().sub(P[(i - 1 + N) % N]).normalize();
      this.T.push(t); this.Lf.push(new THREE.Vector3(t.z, 0, -t.x));
    }
    const kap = new Float64Array(N);
    for (let i = 0; i < N; i++) kap[i] = this.T[(i + 1) % N].clone().sub(this.T[(i - 1 + N) % N]).dot(this.Lf[i]) / (2 * this.ds);
    this.kappa = smooth(kap, Math.round(20 / this.ds));
    const off = new Float64Array(N);
    for (let i = 0; i < N; i++) off[i] = clamp(this.kappa[i] * 220, -4.2, 4.2);
    this.line = smooth(off, Math.round(45 / this.ds));          // racing line: inside of corners
    this.street = !!meta.street && !meta.semi_street;
    const wall = new Float64Array(N);
    for (let i = 0; i < N; i++) wall[i] = this.street ? 8.6 : 17 + 10 * Math.min(1, Math.abs(this.kappa[i]) * 70);
    this.wall = smooth(wall, Math.round(60 / this.ds));
    const xs = P.map((p) => p.x), zs = P.map((p) => p.z);
    this.bounds = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  }
  // position on the track at a fraction of the lap, with a lateral offset (m, + = left)
  at(frac, lateral, out, offRoad = false) {
    const f = ((frac % 1) + 1) % 1, x = f * this.N, i = Math.floor(x) % this.N, j = (i + 1) % this.N, t = x - Math.floor(x);
    const raw = lateral + this.line[i] * (1 - t) + this.line[j] * t;
    const lat = offRoad ? raw : clamp(raw, -ROAD_HALF + 1.1, ROAD_HALF - 1.1);
    out.pos.lerpVectors(this.P[i], this.P[j], t).addScaledVector(this.Lf[i], lat);
    out.dir.lerpVectors(this.T[i], this.T[j], t).normalize();
    out.kappa = this.kappa[i] * (1 - t) + this.kappa[j] * t;
    out.index = i;
    return out;
  }
}
function smooth(a, w) {
  const n = a.length, out = new Float64Array(n);
  let s = 0;
  for (let j = -w; j <= w; j++) s += a[(j + n) % n];
  for (let i = 0; i < n; i++) { out[i] = s / (2 * w + 1); s += a[(i + w + 1) % n] - a[(i - w + n) % n]; }
  return out;
}

function ribbon(track, from, to, { y = 0, mask = null, colorFn = null, uvScale = 0, side = 1 } = {}) {
  // strip between lateral offsets from..to (functions of index or numbers)
  const pos = [], col = [], uv = [], idx = [];
  const N = track.N, c = new THREE.Color();
  const val = (v, i) => (typeof v === "function" ? v(i) : v);
  let vi = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    if (mask && !mask(i)) continue;
    const quad = [[i, val(from, i)], [i, val(to, i)], [j, val(to, j)], [j, val(from, j)]];
    quad.forEach(([p, o], k) => {
      const q = track.P[p].clone().addScaledVector(track.Lf[p], o * side);
      pos.push(q.x, y, q.z);
      if (uvScale) uv.push(k === 0 || k === 3 ? 0 : 1, (k < 2 ? i : j === 0 ? N : j) * track.ds / uvScale);
    });
    if (colorFn) { c.set(colorFn(i)); for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b); }
    idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);     // counter-clockwise seen from above
    vi += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (colorFn) g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  if (uvScale) g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function wallGeometry(track, side, height) {
  const pos = [], col = [], idx = [], c = new THREE.Color();
  const N = track.N;
  let vi = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const a = track.P[i].clone().addScaledVector(track.Lf[i], track.wall[i] * side);
    const b = track.P[j].clone().addScaledVector(track.Lf[j], track.wall[j] * side);
    pos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, height, b.z, a.x, height, a.z);
    c.set(BOARD_COLORS[Math.floor((i * track.ds) / 14) % BOARD_COLORS.length]);
    for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
    idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildScenery(scene, track) {
  const group = new THREE.Group();
  const asphalt = canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = "#3b3d42"; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 5000, ["#45474c", "#33353a", "#4b4d52", "#2f3135"], 2);
    g.fillStyle = "#f2f3ef"; g.fillRect(0, 0, 7, h); g.fillRect(w - 7, 0, 7, h);
  }, { clampS: true });
  const roadMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, metalness: 0.0, color: "#ffffff" });
  const road = new THREE.Mesh(ribbon(track, -ROAD_HALF, ROAD_HALF, { y: 0.0, uvScale: 12 }), roadMat);
  group.add(road);

  const corner = (i) => Math.abs(track.kappa[i]) > 1 / 150;
  const kerbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  const kerbColor = (i) => (Math.floor((i * track.ds) / 3) % 2 ? "#d62a24" : "#f2f3ef");
  group.add(new THREE.Mesh(ribbon(track, ROAD_HALF, ROAD_HALF + 1.4, { y: 0.02, mask: corner, colorFn: kerbColor }), kerbMat));
  group.add(new THREE.Mesh(ribbon(track, -ROAD_HALF - 1.4, -ROAD_HALF, { y: 0.02, mask: corner, colorFn: kerbColor }), kerbMat));
  if (!track.street) {
    const runMat = new THREE.MeshStandardMaterial({ color: "#6a6e75", roughness: 0.95 });
    const outside = (side) => (i) => corner(i) && Math.sign(track.kappa[i]) === -side;
    group.add(new THREE.Mesh(ribbon(track, ROAD_HALF + 1.4, (i) => track.wall[i] - 1, { y: 0.01, mask: outside(1) }), runMat));
    group.add(new THREE.Mesh(ribbon(track, (i) => -track.wall[i] + 1, -ROAD_HALF - 1.4, { y: 0.01, mask: outside(-1) }), runMat));
  }
  const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(wallGeometry(track, 1, track.street ? 1.6 : 1.1), wallMat));
  group.add(new THREE.Mesh(wallGeometry(track, -1, track.street ? 1.6 : 1.1), wallMat));

  // ground
  const [x0, x1, z0, z1] = track.bounds, pad = 900;
  const groundTex = canvasTexture(256, 256, (g, w, h) => {
    if (track.street) { g.fillStyle = "#6f7177"; g.fillRect(0, 0, w, h); speckle(g, w, h, 2500, ["#777980", "#686a70"], 3); return; }
    g.fillStyle = "#4e7d3b"; g.fillRect(0, 0, w, h / 2);
    g.fillStyle = "#467335"; g.fillRect(0, h / 2, w, h / 2);
    speckle(g, w, h, 3500, ["#55863f", "#416b31", "#5a8a44"], 2);
  });
  groundTex.repeat.set((x1 - x0 + 2 * pad) / 40, (z1 - z0 + 2 * pad) / 40);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 2 * pad, z1 - z0 + 2 * pad),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((x0 + x1) / 2, -0.03, (z0 + z1) / 2);
  group.add(ground);

  // start/finish line and the start-light gantry
  const checker = canvasTexture(128, 16, (g, w, h) => {
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? "#111" : "#f2f3ef"; g.fillRect(x * 8, y * 8, 8, 8); }
  });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.0), new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8 }));
  const p0 = track.P[0], t0 = track.T[0], l0 = track.Lf[0];
  line.geometry.rotateX(-Math.PI / 2);
  line.rotation.y = Math.atan2(-l0.z, l0.x);
  line.position.set(p0.x, 0.015, p0.z);
  group.add(line);
  const gantry = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: "#2b2f35", roughness: 0.5, metalness: 0.6 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), metal);
    post.position.set(s * (ROAD_HALF + 1.8), 3.5, 0);
    gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 4.2, 0.9, 0.6), metal);
  beam.position.set(0, 6.6, 0);
  gantry.add(beam);
  const lights = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.MeshStandardMaterial({ color: "#220404", emissive: "#ff1a10", emissiveIntensity: 0 });
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), m);
    pod.position.set((i - 2) * 1.0, 6.1, 0.35);
    gantry.add(pod);
    lights.push(m);
  }
  gantry.position.copy(p0);
  gantry.rotation.y = Math.atan2(-t0.x, -t0.z);
  group.add(gantry);

  // grandstands along the main straight
  const crowd = canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = "#3a3f47"; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 3200, ["#e1261c", "#f2c200", "#f2f3ef", "#2a78d6", "#ff8700", "#1d1d1f", "#2bb673", "#e87ba4"], 2);
  });
  const standMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: "#d9dce0", roughness: 0.6 });
  for (let k = -5; k <= 1; k++) {
    const i = (Math.round((k * 45) / track.ds) + track.N) % track.N;
    if (Math.abs(track.kappa[i]) > 1 / 300) continue;
    const side = 1, off = track.wall[i] + 9;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(40, 9, 10), standMat);
    const at = track.P[i].clone().addScaledVector(track.Lf[i], off * side);
    stand.position.set(at.x, 4.5, at.z);
    stand.rotation.y = Math.atan2(-track.T[i].x, -track.T[i].z) + Math.PI / 2;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(42, 0.4, 12), roofMat);
    roof.position.set(0, 7, 0);
    stand.add(roof);
    group.add(stand);
  }

  // trees (or buildings on street circuits), kept clear of the track
  const rng = mulberry(Math.round(track.length));
  const near = [];
  for (let i = 0; i < track.N; i += 6) near.push(track.P[i]);
  const minDist = (x, z) => { let m = Infinity; for (const p of near) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < m) m = d; } return Math.sqrt(m); };
  const spots = [];
  for (let tries = 0; tries < 6000 && spots.length < (track.street ? 260 : 700); tries++) {
    const x = x0 - 250 + rng() * (x1 - x0 + 500), z = z0 - 250 + rng() * (z1 - z0 + 500);
    const d = minDist(x, z);
    if (d > (track.street ? 22 : 38) && d < (track.street ? 140 : 260)) spots.push([x, z, rng()]);
  }
  const dummy = new THREE.Object3D();
  if (track.street) {
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
    const tones = ["#c9c2b3", "#a7adb4", "#8a919a", "#d8d3c8", "#b8a991", "#7e8791"].map((c) => new THREE.Color(c));
    spots.forEach(([x, z, r], i) => {
      dummy.position.set(x, 0, z);
      dummy.scale.set(14 + r * 18, 12 + r * 45, 14 + ((r * 7) % 1) * 18);
      dummy.rotation.y = r * Math.PI;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tones[i % tones.length]);
    });
    group.add(mesh);
  } else {
    const crown = new THREE.ConeGeometry(2.6, 7, 7); crown.translate(0, 6.5, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.45, 3, 6); trunk.translate(0, 1.5, 0);
    const cm = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: "#2f5a2a", roughness: 0.9 }), spots.length);
    const tm = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: "#5a4632", roughness: 1 }), spots.length);
    spots.forEach(([x, z, r], i) => {
      dummy.position.set(x, 0, z);
      const s = 0.8 + r * 0.9; dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      cm.setMatrixAt(i, dummy.matrix); tm.setMatrixAt(i, dummy.matrix);
    });
    group.add(cm, tm);
  }
  scene.add(group);
  return { roadMat, lights };
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function blobTexture() {
  return canvasTexture(64, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    gr.addColorStop(0, "rgba(0,0,0,0.55)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.save(); g.scale(1, 2); g.fillStyle = gr; g.fillRect(0, 0, w, h / 2); g.restore();
  });
}

function safetyCar() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: "#eef0f2", roughness: 0.35, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: "#1c232b", roughness: 0.2, metalness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.7, 4.5), white); body.position.y = 0.55; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.0), glass); cabin.position.set(0, 1.15, 0.3); g.add(cabin);
  const bar = new THREE.MeshStandardMaterial({ color: "#3a2a00", emissive: "#ffb000", emissiveIntensity: 1 });
  const lightbar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.25), bar); lightbar.position.set(0, 1.48, 0.4); g.add(lightbar);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 18); wheelGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: "#111", roughness: 0.9 });
  for (const [x, z] of [[-0.9, -1.4], [0.9, -1.4], [-0.9, 1.4], [0.9, 1.4]]) { const w = new THREE.Mesh(wheelGeo, tyre); w.position.set(x, 0.34, z); g.add(w); }
  g.visible = false;
  g.userData.bar = bar;
  return g;
}

// ---------------------------------------------------------------- the view
export class OnboardView {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.mode = "tcam";
    this.selected = null;
    this.ready = false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ob-canvas";
    container.append(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance",
                                              logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 4000);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.tmp = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), kappa: 0, index: 0 };
    this.v = new THREE.Vector3(); this.w = new THREE.Vector3();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (!r.width) return;
    const h = Math.round(r.width * (r.width < 640 ? 0.75 : 0.5625));
    this.canvas.style.height = `${h}px`;
    this.renderer.setSize(r.width, h, false);
    this.camera.aspect = r.width / h;
    this.camera.updateProjectionMatrix();
    if (this.lastArgs) this.update(...this.lastArgs);
  }

  async load({ circuit, trackMeta, race, entries, colorOf, laps }) {
    this.ready = false;
    if (this.scene) this.dispose(false);
    const scene = new THREE.Scene();
    this.scene = scene;
    this.track = new Track3D(circuit, trackMeta);
    this.trackMeta = trackMeta;
    this.race = race;
    this.laps = laps;
    this.sky = { dry: [new THREE.Color("#8fbbe6"), new THREE.Color("#dfe8ef")], wet: [new THREE.Color("#5c6570"), new THREE.Color("#8d969f")] };
    scene.background = new THREE.Color("#cfdde9");
    scene.fog = new THREE.Fog("#dfe8ef", 250, 1800);
    this.hemi = new THREE.HemisphereLight("#dfeaf5", "#4a5a3a", 1.1);
    this.sun = new THREE.DirectionalLight("#fff6e8", 2.1);
    this.sun.position.set(400, 900, 250);
    scene.add(this.hemi, this.sun);
    const { roadMat, lights } = buildScenery(scene, this.track);
    this.roadMat = roadMat; this.gantryLights = lights;
    this.sc = safetyCar(); scene.add(this.sc);
    this.buildRain();

    const template = await loadCar();
    const blobTex = blobTexture();
    const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
    const blobGeo = new THREE.PlaneGeometry(2.4, 6.2); blobGeo.rotateX(-Math.PI / 2);
    const sprayTex = canvasTexture(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      gr.addColorStop(0, "rgba(235,240,245,0.85)"); gr.addColorStop(1, "rgba(235,240,245,0)");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    const teamColor = {};
    let teamIdx = 0;
    this.cars = Object.entries(entries).map(([key, info]) => {
      const user = !!colorOf[key];
      const team = info.car || key;
      if (!user && !(team in teamColor)) teamColor[team] = FIELD_LIVERIES[teamIdx++ % FIELD_LIVERIES.length];
      const livery = user ? colorOf[key] : teamColor[team];
      const model = template.clone(true);
      const wheels = {};
      const marks = [];
      model.traverse((o) => {
        if (o.name && o.name.startsWith("Wheel_")) { wheels[o.name.slice(6)] = o; o.rotation.order = "YXZ"; }
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const fresh = mats.map((m) => {
          m.side = THREE.FrontSide;            // the cockpit camera sits inside the helmet
          if (!["Livery", "Accent", "Helmet", "TyreMark"].includes(m.name)) return m;
          const c = m.clone();
          if (m.name === "Livery") c.color.set(livery);
          if (m.name === "Accent") c.color.set(user ? "#f2f3ef" : new THREE.Color(livery).lerp(new THREE.Color("#ffffff"), 0.55));
          if (m.name === "Helmet") c.color.set(HELMETS[Math.floor(hash(key) * HELMETS.length)]);
          if (m.name === "TyreMark") marks.push(c);
          return c;
        });
        o.material = Array.isArray(o.material) ? fresh : fresh[0];
      });
      const group = new THREE.Group();
      group.add(model);
      const blob = new THREE.Mesh(blobGeo, blobMat); blob.position.y = 0.02; group.add(blob);
      const spray = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprayTex, transparent: true, depthWrite: false, opacity: 0 }));
      spray.scale.set(4.5, 2.2, 1); spray.position.set(0, 0.9, 3.6); group.add(spray);
      scene.add(group);
      return { key, info, user, livery, group, wheels, marks, spray, jitter: (hash(key + "j") - 0.5) * 1.2,
               grid: (race.cars[key] && race.cars[key].grid) || 1, deltaS: 0,
               lat: 0, lastS: null, speed: 0, accel: 0, lastTyre: null, spin: 0 };
    });
    this.byKey = Object.fromEntries(this.cars.map((c) => [c.key, c]));
    if (!this.selected || !this.byKey[this.selected]) this.selected = Object.keys(colorOf)[0] || this.cars[0].key;
    // trackside TV camera spots every ~350 m
    this.tvSpots = [];
    const step = Math.round(350 / this.track.ds);
    for (let i = 0; i < this.track.N; i += step) {
      const side = (i / step) % 2 ? 1 : -1;
      const p = this.track.P[i].clone().addScaledVector(this.track.Lf[i], side * (this.track.wall[i] + 6));
      p.y = 7;
      this.tvSpots.push({ i, p });
    }
    this.ready = true;
    this.resize();
  }

  buildRain() {
    const n = 1800, pos = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 80, y = Math.random() * 30, z = (Math.random() - 0.5) * 80;
      pos.set([x, y, z, x, y - 0.9, z], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: "#c8d2dc", transparent: true, opacity: 0 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  // drop the render resolution on slow devices so the replay stays smooth
  adapt() {
    const now = performance.now();
    if (this.lastFrame) {
      const dt = now - this.lastFrame;
      if (dt < 250) this.frameMs = this.frameMs ? this.frameMs * 0.95 + dt * 0.05 : dt;
      const pr = this.renderer.getPixelRatio();
      if (this.frameMs > 30 && pr > 0.75 && now - (this.lastAdapt || 0) > 2000) {
        this.renderer.setPixelRatio(Math.max(0.75, pr - 0.5));
        this.lastAdapt = now;
        this.resize();
      }
    }
    this.lastFrame = now;
  }

  setMode(mode) { this.mode = mode; this.camLag = null; if (this.lastArgs) this.update(...this.lastArgs); }
  select(key) { if (this.byKey && this.byKey[key]) { this.selected = key; this.camLag = null; if (this.lastArgs) this.update(...this.lastArgs); } }

  // T = race clock (s); st = per-car state from the replay; ctx = {lap, neutral, wet, leaderD}
  update(T, st, ctx) {
    this.lastArgs = [T, st, ctx];
    if (!this.ready) return;
    this.adapt();
    const tr = this.track, L = tr.length, tmp = this.tmp;
    // weather
    const wet = clamp(ctx.wet || 0, 0, 1);
    const top = this.sky.dry[0].clone().lerp(this.sky.wet[0], wet), hor = this.sky.dry[1].clone().lerp(this.sky.wet[1], wet);
    this.scene.background.copy(hor.clone().lerp(top, 0.35));
    this.scene.fog.color.copy(hor);
    this.scene.fog.far = 1800 - 1300 * wet;
    this.sun.intensity = 2.1 - 1.4 * wet;
    this.roadMat.roughness = 0.92 - 0.6 * wet;
    this.roadMat.color.setScalar(1 - 0.35 * wet);
    this.rain.material.opacity = wet > 0.15 ? 0.25 + 0.45 * wet : 0;
    // start lights
    const lit = T < 0 ? clamp(Math.floor(T + 6), 0, 5) : 0;
    this.gantryLights.forEach((m, i) => { m.emissiveIntensity = i < lit ? 2.5 : 0; });

    // place cars
    const list = [];
    for (const c of this.cars) {
      const x = st[c.key];
      if (!x) { c.group.visible = false; continue; }
      c.state = x;
      const hiddenAfter = x.out ? 45 : x.done ? 8 : Infinity;
      const since = x.out ? T - (x.outAt ?? T) : x.done ? T - x.doneAt : 0;
      c.group.visible = since < hiddenAfter;
      let d = x.d;
      if (x.done) d = x.d + Math.min(8, Math.max(0, T - x.doneAt)) * 0.004;
      const s = d * L;
      // speed estimate (m/s) from the timeline
      c.deltaS = c.lastS !== null && T > c.lastT && T - c.lastT < 30 ? s - c.lastS : 0;
      if (c.lastS !== null && T !== c.lastT) {
        const dt = T - c.lastT;
        if (dt > 0 && dt < 30) {
          const v = clamp((s - c.lastS) / dt, 0, 110);
          const a = (v - c.speed) / dt;
          c.speed += (v - c.speed) * Math.min(1, dt * 4);
          c.accel += (a - c.accel) * Math.min(1, dt * 3);
        } else if (dt < 0 || dt >= 30) { c.speed = x.lapTime ? L / x.lapTime : 0; c.accel = 0; }
      }
      c.lastS = s; c.lastT = T;
      list.push({ c, s, d, x });
    }
    // grid stagger and side-by-side avoidance
    list.sort((a, b) => b.s - a.s);
    list.forEach((o, k) => {
      let target = o.c.jitter;
      if (o.d < 0.12 && o.x.lap === 1) {
        const gridSide = (o.c.grid % 2 ? 1 : -1) * 2.4;
        target = gridSide * (1 - clamp((o.d * L) / 350, 0, 1));
      }
      const ahead = list[k - 1];
      if (ahead && !o.x.out && ahead.s - o.s < 9 && ahead.s - o.s > -1) target = ahead.c.lat > 0 ? -2.6 : 2.6;
      if (o.x.out) target = (o.c.jitter > 0 ? 1 : -1) * (tr.wall[0] - 3);
      o.c.lat += (target - o.c.lat) * 0.12;
      tr.at(o.d, o.c.lat, tmp, !!o.x.out);
      const g = o.c.group;
      g.position.copy(tmp.pos);
      g.rotation.y = Math.atan2(-tmp.dir.x, -tmp.dir.z);
      o.c.kappa = tmp.kappa;
      // wheels: spin and steer
      o.c.spin -= o.c.deltaS / 0.36;
      const steer = clamp(tmp.kappa * 3.6 * 1.6, -0.32, 0.32);
      for (const [k2, w] of Object.entries(o.c.wheels)) { w.rotation.x = o.c.spin; w.rotation.y = k2[0] === "F" ? steer : 0; }
      const ty = o.x.tyre;
      if (ty && ty !== o.c.lastTyre) { o.c.lastTyre = ty; o.c.marks.forEach((m) => m.color.set(TYRE_HEX[ty] || "#888")); }
      o.c.spray.material.opacity = wet > 0.2 ? clamp(wet * (o.c.speed / 70), 0, 0.75) : 0;
    });
    this.order = list.filter((o) => !o.x.out);

    // safety car ahead of the leader
    const leader = this.order[0];
    if (ctx.neutral === "SC" && T > 0 && leader) {
      tr.at(leader.d + 70 / L, 0, tmp);
      this.sc.visible = true;
      this.sc.position.copy(tmp.pos);
      this.sc.rotation.y = Math.atan2(-tmp.dir.x, -tmp.dir.z);
      this.sc.userData.bar.emissiveIntensity = (Math.floor(performance.now() / 250) % 2) ? 2.2 : 0.3;
    } else this.sc.visible = false;

    this.placeCamera(T);
    this.rain.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  placeCamera() {
    const c = this.byKey[this.selected];
    if (!c) return;
    const g = c.group, cam = this.camera;
    g.updateMatrixWorld();
    const shake = reduceMotion() ? 0 : clamp(c.speed / 90, 0, 1) * 0.012;
    if (this.mode === "tcam" || this.mode === "cockpit") {
      const eye = this.mode === "tcam" ? [0, 1.3, 0.78] : [0, 0.97, -0.06];
      cam.fov = this.mode === "tcam" ? 62 : 78;
      cam.position.set(eye[0] + (Math.random() - 0.5) * shake, eye[1] + (Math.random() - 0.5) * shake, eye[2]).applyMatrix4(g.matrixWorld);
      this.v.set(0, this.mode === "tcam" ? 0.1 : 0.62, -28).applyMatrix4(g.matrixWorld);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.v);
      this.camLag = null;
    } else if (this.mode === "chase") {
      cam.fov = 62;
      // rigid mount: a lagging camera falls hundreds of metres behind at 50x replay speed
      cam.position.set(0, 2.5, 8.2).applyMatrix4(g.matrixWorld);
      this.w.set(0, 0.9, -6).applyMatrix4(g.matrixWorld);
      cam.lookAt(this.w);
    } else {
      // trackside: the next camera spot ahead of the car, zoomed in
      const idx = Math.floor((((c.state.d % 1) + 1) % 1) * this.track.N);
      let best = this.tvSpots[0], bestGap = Infinity;
      for (const sp of this.tvSpots) {
        const gap = (sp.i - idx + this.track.N) % this.track.N;
        const adj = gap > this.track.N - Math.round(60 / this.track.ds) ? gap - this.track.N : gap;
        if (adj > -Math.round(60 / this.track.ds) && adj < bestGap) { bestGap = adj; best = sp; }
      }
      cam.position.copy(best.p);
      this.w.copy(g.position); this.w.y = 0.8;
      cam.lookAt(this.w);
      const dist = cam.position.distanceTo(this.w);
      cam.fov = clamp((2 * Math.atan(5.5 / dist) * 180) / Math.PI, 4, 55);
    }
    cam.updateProjectionMatrix();
  }

  // numbers for the HUD
  hud() {
    const c = this.byKey && this.byKey[this.selected];
    if (!c || !c.state) return null;
    const pos = this.order ? this.order.findIndex((o) => o.c === c) : -1;
    const kmh = c.speed * 3.6;
    const gears = [0, 95, 130, 165, 200, 235, 268, 298];
    let gear = 1; for (let i = 0; i < gears.length; i++) if (kmh >= gears[i]) gear = i + 1;
    const lo = gears[gear - 1], hi = gears[gear] || 340;
    const rpm = c.state.out || c.state.done && kmh < 5 ? 0 : clamp((kmh - lo) / (hi - lo), 0, 1);
    const throttle = c.accel > -1.5 ? clamp(0.55 + c.accel / 6, 0.2, 1) : 0;
    const brake = c.accel < -2.5 ? clamp(-c.accel / 30, 0.2, 1) : 0;
    const ahead = pos > 0 ? this.order[pos - 1] : null, behind = pos >= 0 && pos < this.order.length - 1 ? this.order[pos + 1] : null;
    const gapTo = (o) => (o && pos >= 0 ? Math.abs(o.s - this.order[pos].s) / Math.max(20, c.speed || 60) : null);
    return { car: c, position: pos + 1, kmh, gear, rpm, throttle, brake, out: !!c.state.out,
             ahead: ahead && { name: shortName(ahead.c.info), gap: gapTo(ahead) }, behind: behind && { name: shortName(behind.c.info), gap: gapTo(behind) },
             tyre: c.state.tyre, tyreName: TYRE_NAME[c.state.tyre] || "", tyreHex: TYRE_HEX[c.state.tyre] || "#888" };
  }

  dispose(full = true) {
    if (this.scene) {
      this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.scene = null;
    }
    if (full) { this.ro.disconnect(); this.renderer.dispose(); this.canvas.remove(); }
  }
}
