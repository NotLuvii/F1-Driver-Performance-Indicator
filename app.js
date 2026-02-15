/**
 * F1 Era Crossover Simulator
 * OpenF1 API + GeoJSON track maps + era-based prediction.
 * Run by opening index.html in a browser.
 */

// --- Constants ---

const OPENF1_DRIVERS_URL = 'https://api.openf1.org/v1/drivers?year=2024';
const OPENF1_SESSIONS_URL = 'https://api.openf1.org/v1/sessions?year=2024&session_type=Race';

// Era order for adaptability (how many "steps" apart driver era and car era are)
const ERA_ORDER = ['1970s', '1980s', '1990s', '2000s', '2010s', '2020s', '2025'];

const ERA_FACTORS = {
  '1970s': { speed: 0.72, grip: 0.65 },
  '1980s': { speed: 0.80, grip: 0.70 },
  '1990s': { speed: 0.85, grip: 0.78 },
  '2000s': { speed: 0.92, grip: 0.88 },
  '2010s': { speed: 0.96, grip: 0.92 },
  '2020s': { speed: 0.98, grip: 0.96 },
  '2025':  { speed: 1.00, grip: 1.00 },
};

// Car packages: era, team name, speed, grip (0–1 scale for that era)
const CAR_PACKAGES = [
  { id: 'ferrari_1976', label: 'Ferrari 1976 (Low downforce)', era: '1970s', speed: 0.88, grip: 0.70 },
  { id: 'mclaren_1988', label: 'McLaren 1988 (Turbo)', era: '1980s', speed: 0.95, grip: 0.82 },
  { id: 'williams_1992', label: 'Williams 1992', era: '1990s', speed: 0.92, grip: 0.85 },
  { id: 'ferrari_2004', label: 'Ferrari 2004 (V10 peak)', era: '2000s', speed: 0.98, grip: 0.92 },
  { id: 'redbull_2013', label: 'Red Bull 2013', era: '2010s', speed: 0.96, grip: 0.94 },
  { id: 'mercedes_2020', label: 'Mercedes 2020 (Hybrid)', era: '2020s', speed: 0.98, grip: 0.96 },
  { id: 'redbull_2025', label: 'Red Bull 2025 (Ground effect)', era: '2025', speed: 1.00, grip: 1.00 },
  { id: 'ferrari_2025', label: 'Ferrari 2025', era: '2025', speed: 0.97, grip: 0.98 },
  { id: 'mclaren_2025', label: 'McLaren 2025', era: '2025', speed: 0.96, grip: 0.96 },
];

// Fallback drivers if APIs fail (modern + legends). skill = peak in their era; eraAdaptability = how well they'd adapt to other eras (car feel, driving style).
const FALLBACK_DRIVERS = [
  { id: 'verstappen', name: 'Max Verstappen', era: '2020s', skill: 0.98, aggression: 0.90, eraAdaptability: 0.95 },
  { id: 'hamilton', name: 'Lewis Hamilton', era: '2020s', skill: 0.96, aggression: 0.85, eraAdaptability: 0.94 },
  { id: 'leclerc', name: 'Charles Leclerc', era: '2020s', skill: 0.94, aggression: 0.88, eraAdaptability: 0.92 },
  { id: 'norris', name: 'Lando Norris', era: '2020s', skill: 0.93, aggression: 0.82, eraAdaptability: 0.93 },
  { id: 'piastri', name: 'Oscar Piastri', era: '2020s', skill: 0.91, aggression: 0.78, eraAdaptability: 0.91 },
  { id: 'alonso', name: 'Fernando Alonso', era: '2020s', skill: 0.92, aggression: 0.86, eraAdaptability: 0.96 },
  { id: 'senna', name: 'Ayrton Senna', era: '1980s', skill: 0.99, aggression: 0.95, eraAdaptability: 0.88 },
  { id: 'schumacher', name: 'Michael Schumacher', era: '2000s', skill: 0.97, aggression: 0.92, eraAdaptability: 0.90 },
  { id: 'prost', name: 'Alain Prost', era: '1980s', skill: 0.96, aggression: 0.78, eraAdaptability: 0.86 },
  { id: 'lauda', name: 'Niki Lauda', era: '1970s', skill: 0.94, aggression: 0.82, eraAdaptability: 0.82 },
  { id: 'hunt', name: 'James Hunt', era: '1970s', skill: 0.90, aggression: 0.88, eraAdaptability: 0.78 },
  { id: 'mansell', name: 'Nigel Mansell', era: '1980s', skill: 0.93, aggression: 0.90, eraAdaptability: 0.84 },
  { id: 'hakkinen', name: 'Mika Häkkinen', era: '1990s', skill: 0.94, aggression: 0.85, eraAdaptability: 0.86 },
  { id: 'raikkonen', name: 'Kimi Räikkönen', era: '2000s', skill: 0.91, aggression: 0.80, eraAdaptability: 0.88 },
];

const TRACK_IDS = ['monaco', 'spa', 'suzuka', 'silverstone', 'interlagos'];

// Fallback track data when JSON cannot be fetched (e.g. file://) — minimal point loop per track
const FALLBACK_TRACKS = {
  monaco: { name: 'Monaco', lengthKm: 3.337, difficulty: 0.95, corneringImportance: 0.92, viewBox: [0, 0, 500, 280], points: [[368, 218], [335, 195], [288, 185], [242, 188], [198, 205], [162, 235], [142, 268], [152, 258], [188, 228], [235, 208], [282, 198], [328, 208], [358, 232], [372, 262], [355, 272], [312, 262], [265, 252], [218, 258], [178, 272], [152, 278], [158, 255], [198, 222], [248, 202], [295, 198], [332, 215], [352, 248], [348, 272], [318, 268], [272, 258], [228, 255], [192, 268], [172, 275], [178, 258], [212, 232], [258, 212], [298, 208], [328, 228], [338, 258], [325, 268], [288, 262], [248, 255], [212, 262], [188, 272], [185, 262], [215, 238], [258, 218], [292, 212], [318, 228], [322, 252], [302, 262], [268, 255], [232, 258], [205, 268], [192, 265], [212, 242], [252, 222], [282, 218], [305, 228], [312, 248], [292, 258], [262, 252], [235, 255], [215, 265], [218, 252], [242, 235], [272, 222], [292, 225], [298, 242], [285, 255], [262, 252], [245, 255], [238, 248], [258, 235], [272, 232], [275, 242], [265, 248]] },
  spa: { name: 'Spa-Francorchamps', lengthKm: 7.004, difficulty: 0.9, corneringImportance: 0.78, viewBox: [0, 0, 500, 280], points: [[252, 242], [285, 228], [318, 205], [348, 172], [362, 132], [365, 88], [352, 48], [322, 22], [282, 12], [242, 22], [212, 48], [198, 92], [202, 142], [222, 188], [255, 218], [292, 228], [332, 218], [358, 188], [368, 148], [362, 105], [338, 68], [302, 45], [262, 42], [228, 58], [212, 95], [215, 142], [238, 182], [272, 205], [308, 208], [338, 192], [352, 158], [348, 118], [328, 82], [292, 62], [252, 65], [222, 88], [212, 128], [222, 168], [252, 195], [288, 202], [318, 188], [338, 158], [338, 115], [315, 82], [278, 68], [242, 78], [218, 105], [215, 148], [238, 182], [268, 195], [298, 188], [318, 162], [318, 122], [295, 92], [262, 82], [232, 95], [218, 132], [228, 168], [258, 188], [288, 185], [308, 165], [312, 132], [298, 102], [268, 88], [238, 95], [222, 128], [228, 162], [255, 182], [282, 178], [302, 158], [302, 122], [282, 95], [252, 88], [228, 105], [228, 142], [252, 168], [278, 172], [292, 152], [288, 118], [262, 105], [238, 112], [232, 142], [252, 162], [272, 158], [278, 135], [262, 112], [242, 112], [232, 132], [252, 148], [265, 138], [262, 118]] },
  suzuka: { name: 'Suzuka', lengthKm: 5.807, difficulty: 0.88, corneringImportance: 0.85, viewBox: [0, 0, 500, 280], points: [[250, 142], [272, 128], [298, 105], [312, 75], [315, 42], [302, 18], [272, 8], [242, 18], [222, 48], [218, 92], [232, 138], [258, 172], [292, 188], [328, 182], [358, 158], [368, 122], [362, 82], [338, 48], [302, 32], [262, 38], [232, 62], [218, 102], [222, 148], [248, 182], [282, 192], [318, 182], [348, 158], [358, 122], [352, 82], [328, 52], [292, 42], [252, 52], [225, 78], [218, 118], [232, 162], [262, 185], [298, 188], [328, 172], [348, 142], [348, 105], [328, 72], [292, 58], [252, 62], [225, 88], [218, 128], [238, 165], [268, 182], [302, 178], [328, 158], [338, 125], [332, 88], [308, 62], [272, 55], [242, 68], [225, 102], [228, 142], [255, 172], [288, 178], [312, 162], [322, 132], [315, 98], [288, 75], [255, 72], [232, 95], [228, 135], [252, 162], [278, 168], [298, 152], [298, 118], [275, 92], [248, 88], [228, 108], [232, 142], [258, 162], [282, 162], [295, 142], [288, 112], [262, 98], [238, 105], [235, 135], [258, 152], [272, 148], [272, 122], [255, 108], [242, 118], [248, 138], [262, 138], [258, 118]] },
  silverstone: { name: 'Silverstone', lengthKm: 5.891, difficulty: 0.86, corneringImportance: 0.82, viewBox: [0, 0, 500, 280], points: [[338, 142], [362, 122], [382, 92], [388, 58], [372, 28], [338, 12], [298, 18], [268, 42], [252, 82], [252, 128], [272, 168], [308, 192], [348, 198], [388, 182], [418, 152], [428, 112], [418, 68], [388, 35], [348, 22], [302, 32], [268, 58], [252, 98], [258, 142], [282, 182], [318, 202], [358, 198], [392, 178], [412, 148], [412, 105], [392, 65], [358, 38], [312, 32], [272, 52], [252, 92], [258, 138], [282, 178], [318, 192], [352, 188], [378, 168], [392, 135], [388, 92], [362, 58], [322, 42], [278, 52], [252, 88], [252, 132], [272, 172], [308, 192], [342, 192], [372, 172], [392, 142], [392, 98], [368, 62], [328, 45], [282, 52], [252, 78], [245, 122], [262, 165], [298, 188], [332, 185], [358, 165], [368, 132], [358, 92], [328, 62], [288, 52], [252, 68], [242, 112], [258, 155], [288, 178], [322, 178], [348, 162], [355, 128], [342, 92], [308, 72], [268, 75], [242, 98], [242, 138], [265, 172], [298, 182], [325, 172], [338, 142], [322, 108], [288, 92], [255, 98], [242, 132], [262, 162], [288, 168], [308, 152], [308, 118], [282, 95], [252, 98], [242, 128], [262, 155], [282, 158], [292, 138], [278, 112], [252, 108], [245, 132], [262, 148], [272, 132], [262, 112]] },
  interlagos: { name: 'Interlagos', lengthKm: 4.309, difficulty: 0.82, corneringImportance: 0.78, viewBox: [0, 0, 500, 280], points: [[258, 188], [288, 172], [318, 148], [338, 115], [342, 78], [328, 45], [298, 25], [262, 22], [228, 42], [208, 82], [208, 128], [228, 172], [262, 198], [302, 198], [338, 182], [358, 152], [358, 112], [338, 72], [302, 45], [262, 38], [225, 58], [212, 98], [218, 142], [242, 182], [278, 195], [318, 188], [348, 165], [355, 128], [342, 88], [308, 62], [265, 58], [228, 78], [215, 122], [228, 168], [262, 192], [298, 188], [328, 168], [338, 132], [328, 92], [292, 68], [252, 68], [218, 92], [212, 135], [235, 172], [272, 188], [308, 182], [332, 158], [332, 115], [308, 78], [268, 62], [232, 72], [215, 112], [222, 155], [255, 182], [288, 182], [312, 162], [315, 122], [298, 88], [262, 75], [232, 88], [222, 128], [238, 165], [272, 178], [298, 172], [315, 148], [308, 112], [278, 88], [242, 88], [222, 112], [222, 152], [248, 178], [278, 178], [298, 158], [295, 118], [268, 95], [238, 98], [228, 132], [248, 162], [272, 165], [282, 142], [268, 112], [242, 105], [228, 128], [242, 152], [262, 152], [268, 128], [252, 112], [242, 128], [255, 138], [262, 122]] },
};

// --- State ---

let drivers = [];
let tracks = {};

// --- Era adaptability: driver in different era = different car feel, driving style ---

function getEraMatchFactor(driverEra, carEra, eraAdaptability) {
  if (driverEra === carEra) return 1;
  const di = ERA_ORDER.indexOf(driverEra);
  const ci = ERA_ORDER.indexOf(carEra);
  if (di < 0 || ci < 0) return 0.9;
  const steps = Math.abs(ci - di);
  // Each era step reduces effectiveness; adaptability softens the penalty (0.85 base, up to 0.98 with high adaptability)
  const penaltyPerStep = 0.04 * (1 - eraAdaptability);
  const factor = 1 - steps * penaltyPerStep;
  return Math.max(0.75, Math.min(1, factor));
}

// --- API: Fetch drivers and compute skill from real lap data ---

async function fetchOpenF1DriversWithSkill() {
  const driversRes = await fetch(OPENF1_DRIVERS_URL);
  if (!driversRes.ok) return [];
  const driversData = await driversRes.json();
  const byNumber = new Map();
  driversData.forEach((d) => {
    const name = d.full_name || d.broadcast_name || (d.first_name && d.last_name ? `${d.first_name} ${d.last_name}` : null);
    if (name && !name.startsWith('FOM') && !name.startsWith('FIA')) {
      const key = d.driver_number;
      if (!byNumber.has(key)) byNumber.set(key, { id: `openf1_${key}`, name, driver_number: key, era: '2020s', eraAdaptability: 0.93 });
    }
  });
  if (byNumber.size === 0) return [];

  // Fetch Race sessions for 2024
  let sessionKeys = [];
  try {
    const sessionsRes = await fetch(OPENF1_SESSIONS_URL);
    if (sessionsRes.ok) {
      const sessions = await sessionsRes.json();
      sessionKeys = sessions.slice(0, 6).map((s) => s.session_key).filter(Boolean);
    }
  } catch (_) {}

  // Aggregate lap times per driver from multiple sessions (median lap duration = pace)
  const lapTimesByDriver = new Map();
  for (const sk of sessionKeys) {
    try {
      const lapsRes = await fetch(`https://api.openf1.org/v1/laps?session_key=${sk}`);
      if (!lapsRes.ok) continue;
      const laps = await lapsRes.json();
      laps.forEach((lap) => {
        const num = lap.driver_number;
        const dur = lap.lap_duration ?? lap.duration;
        if (num == null || dur == null || typeof dur !== 'number' || dur < 50 || dur > 200) return;
        if (!lapTimesByDriver.has(num)) lapTimesByDriver.set(num, []);
        lapTimesByDriver.get(num).push(dur);
      });
    } catch (_) {}
  }

  // Per driver: median lap time (lower = faster = higher skill)
  const driverMedians = [];
  byNumber.forEach((driver, num) => {
    const times = lapTimesByDriver.get(num);
    if (!times || times.length < 3) return;
    const sorted = [...times].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    driverMedians.push({ driver_number: num, median });
  });

  if (driverMedians.length < 2) return Array.from(byNumber.values()).map((d) => ({ ...d, skill: 0.9, aggression: 0.8 }));

  // Rank: fastest median = 0.99, slowest = 0.85 (linear scale)
  driverMedians.sort((a, b) => a.median - b.median);
  const minM = driverMedians[0].median;
  const maxM = driverMedians[driverMedians.length - 1].median;
  const span = maxM - minM || 1;
  const skillByNumber = new Map();
  driverMedians.forEach(({ driver_number, median }, i) => {
    const t = (median - minM) / span;
    const skill = 0.99 - t * 0.14;
    skillByNumber.set(driver_number, Math.max(0.85, Math.min(0.99, skill)));
  });

  return Array.from(byNumber.values()).map((d) => {
    const skill = skillByNumber.get(d.driver_number) ?? 0.9;
    const aggression = 0.75 + (1 - (skill - 0.85) / 0.14) * 0.15;
    return { id: d.id, name: d.name, era: d.era, eraAdaptability: d.eraAdaptability, skill, aggression };
  });
}

function normalizeDriver(d) {
  return {
    id: d.id,
    name: d.name,
    era: d.era || '2020s',
    skill: typeof d.skill === 'number' ? d.skill : 0.9,
    aggression: typeof d.aggression === 'number' ? d.aggression : 0.8,
    eraAdaptability: typeof d.eraAdaptability === 'number' ? d.eraAdaptability : 0.9,
  };
}

async function loadDrivers() {
  const byName = new Map();
  FALLBACK_DRIVERS.forEach((d) => byName.set(d.name, normalizeDriver(d)));
  try {
    const openF1 = await fetchOpenF1DriversWithSkill();
    openF1.forEach((d) => {
      byName.set(d.name, normalizeDriver(d));
    });
  } catch (_) {}
  drivers = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// --- Tracks: Load GeoJSON ---

async function loadTracks() {
  for (const id of TRACK_IDS) {
    try {
      const res = await fetch(`tracks/${id}.json`);
      if (res.ok) tracks[id] = await res.json();
    } catch (_) {}
    if (!tracks[id]) tracks[id] = FALLBACK_TRACKS[id];
  }
}

// --- Prediction model (era-based) ---

/**
 * Lap time formula. Skill is from real lap data; effectiveSkill is reduced when driver era ≠ car era (different car feel, driving style).
 */
function predictLapTime(driver, car, track) {
  const era = ERA_FACTORS[car.era] || ERA_FACTORS['2025'];
  const baseTime = track.lengthKm * 21;

  const eraMatch = getEraMatchFactor(driver.era, car.era, driver.eraAdaptability);
  const effectiveSkill = driver.skill * eraMatch;

  const driverGain = effectiveSkill * 5;
  const carGain = car.speed * 4;
  const gripGain = car.grip * (track.corneringImportance || 0.8) * 3.5;
  const eraPenalty = (1 - era.speed) * 18;
  const trackDifficulty = (track.difficulty || 0.8) * 2.5;

  const randomFactor = (driver.aggression - 0.5) * 0.6;
  let total = baseTime - driverGain - carGain - gripGain + eraPenalty + trackDifficulty + randomFactor;
  total = Math.max(55, Math.min(200, total));

  const formatted = formatLapTime(total);
  const breakdown = [
    { text: `${driver.name} gains +${driverGain.toFixed(1)}s from skill (${driver.era} pace)`, type: 'gain' },
  ];
  if (eraMatch < 1) {
    breakdown.push({ text: `Era crossover: ${driver.era} driver in ${car.era} car costs −${((1 - eraMatch) * driver.skill * 5).toFixed(1)}s (different car feel)`, type: 'loss' });
  }
  breakdown.push(
    { text: `Car contributes +${carGain.toFixed(1)}s (speed)`, type: 'gain' },
    { text: `Grip/cornering adds +${gripGain.toFixed(1)}s`, type: 'gain' },
    { text: `${car.era} era penalty +${eraPenalty.toFixed(1)}s`, type: eraPenalty > 0 ? 'loss' : 'neutral' },
    { text: `${track.name} difficulty +${trackDifficulty.toFixed(1)}s`, type: 'neutral' }
  );

  return { formatted, seconds: total, breakdown };
}

function formatLapTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const sec = Math.floor(s);
  const ms = Math.round((s - sec) * 1000);
  return `${m}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// --- Track canvas: draw and animate ---

const canvas = document.getElementById('track-canvas');
const ctx = canvas.getContext('2d');
let animationFrameId = null;

function getTrackBounds(points) {
  if (!points || points.length < 2) return [0, 0, 500, 280];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(([x, y]) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  const pad = 25;
  return [minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad];
}

function drawTrack(trackData) {
  if (!trackData || !trackData.points || trackData.points.length < 2) return;
  const w = canvas.width;
  const h = canvas.height;
  const bounds = getTrackBounds(trackData.points);
  const [bx, by, bw, bh] = bounds;
  const scaleX = w / bw;
  const scaleY = h / bh;
  const scale = Math.min(scaleX, scaleY);
  const ox = (w - bw * scale) / 2 - bx * scale;
  const oy = (h - bh * scale) / 2 - by * scale;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(42, 42, 58, 1)';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const [fx, fy] = trackData.points[0];
  ctx.moveTo(ox + fx * scale, oy + fy * scale);
  for (let i = 1; i < trackData.points.length; i++) {
    const [px, py] = trackData.points[i];
    ctx.lineTo(ox + px * scale, oy + py * scale);
  }
  ctx.lineTo(ox + fx * scale, oy + fy * scale);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(225, 6, 0, 0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(ox + trackData.points[0][0] * scale, oy + trackData.points[0][1] * scale);
  for (let i = 1; i < trackData.points.length; i++) {
    ctx.lineTo(ox + trackData.points[i][0] * scale, oy + trackData.points[i][1] * scale);
  }
  ctx.closePath();
  ctx.stroke();
}

/**
 * Animate a dot around the track path. One lap in lapTimeSeconds.
 */
function animateCarLap(trackPoints, viewBox, lapTimeSeconds) {
  if (!trackPoints || trackPoints.length < 2) return;
  if (animationFrameId != null) cancelAnimationFrame(animationFrameId);

  const w = canvas.width;
  const h = canvas.height;
  const bounds = getTrackBounds(trackPoints);
  const [bx, by, bw, bh] = bounds;
  const scaleX = w / bw;
  const scaleY = h / bh;
  const scale = Math.min(scaleX, scaleY);
  const ox = (w - bw * scale) / 2 - bx * scale;
  const oy = (h - bh * scale) / 2 - by * scale;

  const durationMs = lapTimeSeconds * 1000;
  const start = performance.now();
  const totalLen = getPathLength(trackPoints);

  function tick(now) {
    const elapsed = (now - start) % durationMs;
    const progress = elapsed / durationMs;
    const dist = progress * totalLen;
    const pt = getPointAtDistance(trackPoints, dist);
    const sx = ox + pt.x * scale;
    const sy = oy + pt.y * scale;

    const currentTrack = document.getElementById('track-select').value;
    const trackData = tracks[currentTrack];
    if (trackData) {
      ctx.clearRect(0, 0, w, h);
      drawTrack(trackData);
    }
    ctx.fillStyle = '#e10600';
    ctx.shadowColor = 'rgba(225, 6, 0, 0.8)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    animationFrameId = requestAnimationFrame(tick);
  }
  animationFrameId = requestAnimationFrame(tick);
}

function getPathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    len += Math.hypot(x1 - x0, y1 - y0);
  }
  const [x0, y0] = points[points.length - 1];
  const [x1, y1] = points[0];
  len += Math.hypot(x1 - x0, y1 - y0);
  return len;
}

function getPointAtDistance(points, distance) {
  const total = getPathLength(points);
  let d = distance % total;
  if (d < 0) d += total;
  for (let i = 1; i <= points.length; i++) {
    const i0 = (i - 1) % points.length;
    const i1 = i % points.length;
    const [x0, y0] = points[i0];
    const [x1, y1] = points[i1];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (d <= seg) {
      const t = seg > 0 ? d / seg : 0;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }
    d -= seg;
  }
  return { x: points[0][0], y: points[0][1] };
}

// --- UI ---

function populateCarSelect() {
  const sel = document.getElementById('car-select');
  sel.innerHTML = '<option value="">— Select Car —</option>';
  CAR_PACKAGES.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    sel.appendChild(opt);
  });
}

function populateTrackSelect() {
  const sel = document.getElementById('track-select');
  sel.innerHTML = '<option value="">— Select Track —</option>';
  TRACK_IDS.forEach((id) => {
    const t = tracks[id];
    if (t) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  });
}

function populateDriverSelect() {
  const sel = document.getElementById('driver-select');
  sel.innerHTML = '<option value="">— Select Driver —</option>';
  drivers.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  });
}

function getSelectedDriver() {
  const id = document.getElementById('driver-select').value;
  return drivers.find((d) => d.id === id) || null;
}

function getSelectedCar() {
  const id = document.getElementById('car-select').value;
  return CAR_PACKAGES.find((c) => c.id === id) || null;
}

function getSelectedTrack() {
  const id = document.getElementById('track-select').value;
  return tracks[id] || null;
}

function showResult(result) {
  const area = document.getElementById('result-area');
  const placeholder = document.getElementById('result-placeholder');
  const timeEl = document.getElementById('result-time');
  const breakdownEl = document.getElementById('result-breakdown');

  area.classList.remove('result-area--empty');
  timeEl.textContent = result.formatted;
  timeEl.setAttribute('aria-hidden', 'false');
  breakdownEl.innerHTML = '';
  result.breakdown.forEach((b) => {
    const li = document.createElement('li');
    li.className = b.type;
    li.textContent = b.text;
    breakdownEl.appendChild(li);
  });
  breakdownEl.setAttribute('aria-hidden', 'false');
}

function onTrackChange() {
  const id = document.getElementById('track-select').value;
  const trackData = tracks[id];
  const legend = document.getElementById('track-legend');
  if (trackData) {
    drawTrack(trackData);
    legend.textContent = `${trackData.name} — ${trackData.lengthKm} km`;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    legend.textContent = 'Select a track.';
  }
}

function onPredictClick() {
  const driver = getSelectedDriver();
  const car = getSelectedCar();
  const track = getSelectedTrack();

  if (!driver || !car || !track) {
    alert('Please select a driver, car, and track.');
    return;
  }

  const result = predictLapTime(driver, car, track);
  showResult(result);

  document.getElementById('track-legend').textContent = `1 lap = ${result.seconds.toFixed(1)}s`;
  animateCarLap(track.points, track.viewBox, result.seconds);
}

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  populateCarSelect();
  await loadTracks();
  populateTrackSelect();
  await loadDrivers();
  populateDriverSelect();

  document.getElementById('predict-btn').addEventListener('click', onPredictClick);
  document.getElementById('track-select').addEventListener('change', onTrackChange);

  const firstTrack = TRACK_IDS.find((id) => tracks[id]);
  if (firstTrack) {
    document.getElementById('track-select').value = firstTrack;
    onTrackChange();
  }
});
