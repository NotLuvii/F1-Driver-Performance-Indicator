/* F1 Driver Performance Indicator: browser port of the Python simulator (f1dpi/engine.py,
 * tyres.py, model.py, montecarlo.py). The ratings are fitted in Python and loaded from
 * data/ratings.json and data/tracks.json; this file only runs races.
 * Works in a browser page, a Web Worker (importScripts) and Node (require). */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ random numbers
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    let spare = null;
    function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      random: next,
      uniform: (lo, hi) => lo + (hi - lo) * next(),
      integers: (lo, hi) => lo + Math.floor(next() * (hi - lo)), // [lo, hi)
      normal(mu, sd) {
        let z;
        if (spare !== null) { z = spare; spare = null; }
        else {
          let u = 0; while (u === 0) u = next();
          const v = next(), r = Math.sqrt(-2 * Math.log(u));
          z = r * Math.cos(2 * Math.PI * v); spare = r * Math.sin(2 * Math.PI * v);
        }
        return mu + sd * z;
      },
      weighted(weights) {
        const tot = weights.reduce((s, w) => s + w, 0);
        let x = next() * tot;
        for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
        return weights.length - 1;
      },
      pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    };
  }

  // ------------------------------------------------------------------ tyres
  const COMPOUNDS = {
    S: { name: "Soft", offset: 0.0, wear: 0.1, life: 15 },
    M: { name: "Medium", offset: 0.4, wear: 0.055, life: 27 },
    H: { name: "Hard", offset: 0.75, wear: 0.035, life: 40 },
    I: { name: "Intermediate", offset: 0.0, wear: 0.04, life: 35, wet: true },
    W: { name: "Full wet", offset: 0.0, wear: 0.03, life: 45, wet: true },
  };
  const DRY = ["S", "M", "H"];
  const isDry = (c) => c === "S" || c === "M" || c === "H";
  const CLIFF = 0.12;
  const WEAR_BUCKETS = Array.from({ length: 17 }, (_, i) => 0.45 * Math.pow(2.4 / 0.45, i / 16));

  function lapCost(code, age, wear, scale) {
    const c = COMPOUNDS[code], life = c.life / wear, over = Math.max(0, age - life);
    return (c.offset + c.wear * wear * age + CLIFF * over * over) * scale;
  }
  function weatherPenalty(code, w) {
    if (isDry(code)) return Math.max(0, w - 0.12) * 0.4;
    if (code === "I") return 0.06 * Math.max(0, 0.45 - w) / 0.45 + 0.1 * Math.max(0, w - 0.7) / 0.3;
    return 0.02 + 0.1 * Math.max(0, 0.75 - w) / 0.75;
  }
  function bestTyreFor(w) {
    let best = "S", bp = weatherPenalty("S", w);
    for (const c of ["I", "W"]) { const p = weatherPenalty(c, w); if (p < bp) { best = c; bp = p; } }
    return best;
  }
  function wearBucket(wear) {
    let bi = 0, bd = Infinity; const lw = Math.log(wear);
    WEAR_BUCKETS.forEach((b, i) => { const d = Math.abs(Math.log(b) - lw); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  const cumCache = new Map();
  function cumCosts(code, bucket, laps) {
    const key = code + "|" + bucket + "|" + laps;
    let v = cumCache.get(key);
    if (v) return v;
    const wear = WEAR_BUCKETS[bucket], c = COMPOUNDS[code], life = c.life / wear;
    v = new Float64Array(laps + 1);
    for (let a = 0; a < laps; a++) {
      const over = Math.max(0, a - life);
      v[a + 1] = v[a] + c.offset + c.wear * wear * a + CLIFF * over * over;
    }
    cumCache.set(key, v);
    return v;
  }
  function product(k) {
    if (k === 0) return [[]];
    const out = [];
    for (const head of DRY) for (const tail of product(k - 1)) out.push([head, ...tail]);
    return out;
  }
  const SEQS = [1, 2, 3, 4].map(product);
  const planCache = new Map();
  function optimise(laps, bucket, pitRef, used, minStint = 4) {
    const key = laps + "|" + bucket + "|" + pitRef + "|" + used;
    let cached = planCache.get(key);
    if (cached) return cached;
    const plans = [], waived = used === "*";
    for (let k = 1; k <= 4; k++) {
      if (k === 1 && laps > 45) continue;
      for (const seq of SEQS[k - 1]) {
        if (!waived && new Set([...seq, ...used.split("")]).size < 2) continue;
        if (k * minStint > laps) continue;
        const cums = seq.map((c) => cumCosts(c, bucket, laps));
        if (k === 1) plans.push({ stints: [[seq[0], laps]], cost: cums[0][laps] });
        else if (k === 2) {
          let best = Infinity, bn = 0;
          for (let n1 = minStint; n1 <= laps - minStint; n1++) {
            const c = cums[0][n1] + cums[1][laps - n1];
            if (c < best) { best = c; bn = n1; }
          }
          plans.push({ stints: [[seq[0], bn], [seq[1], laps - bn]], cost: best + pitRef });
        } else if (k === 3) {
          let best = Infinity, ba = 0, bb = 0;
          for (let n1 = minStint; n1 <= laps - 2 * minStint; n1++)
            for (let n2 = minStint; n2 <= laps - 2 * minStint; n2++) {
              const n3 = laps - n1 - n2;
              if (n3 < minStint) continue;
              const c = cums[0][n1] + cums[1][n2] + cums[2][n3];
              if (c < best) { best = c; ba = n1; bb = n2; }
            }
          plans.push({ stints: [[seq[0], ba], [seq[1], bb], [seq[2], laps - ba - bb]], cost: best + 2 * pitRef });
        } else {
          const base = Math.floor(laps / k), lens = Array(k).fill(base);
          lens[k - 1] += laps - base * k;
          let c = 3 * pitRef;
          lens.forEach((n, i) => { c += cums[i][n]; });
          plans.push({ stints: seq.map((s, i) => [s, lens[i]]), cost: c });
        }
      }
    }
    plans.sort((a, b) => a.cost - b.cost);
    cached = plans.slice(0, 12);
    planCache.set(key, cached);
    return cached;
  }
  function choosePlan(laps, wear, pitLoss, scale, used, rng, spread = 2.5) {
    const plans = optimise(laps, wearBucket(wear), Math.round((pitLoss / scale) * 10) / 10, used);
    if (!plans.length) return { stints: [["H", laps]], cost: 0 };
    const costs = plans.map((p) => p.cost * scale), lo = Math.min(...costs);
    return plans[rng.weighted(costs.map((c) => Math.exp(-(c - lo) / spread)))];
  }

  // ------------------------------------------------------------------ race engine
  const REF_PACE = 1.5, GRID_SLOT_GAP = 0.25, START_LOSS = 2.2;
  const SC_LAP = 1.4, VSC_LAP = 1.3, SC_PIT = 0.55, VSC_PIT = 0.65;
  const DEFAULT_SETTINGS = {
    weather: "random", safetyCar: true, incidents: true, laps: null,
    formSd: 0.3, carFormSd: 0.18, lapSdPct: 0.22, qualiSdPct: 0.18, carWearSd: 0.15,
    dayWearSd: 0.12, crashRate: 0.034, qualiMishap: 0.06, raceMistake: 0.05, lap1CrashMult: 6,
  };
  const FAILURES = ["Engine", "Gearbox", "Hydraulics", "Power unit", "Suspension", "Brakes", "Electrical"];
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const argsort = (arr) => arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);

  class RaceSimulator {
    constructor(track, entries, pctPerUnit, settings) {
      this.track = track;
      this.E = entries;
      this.k = pctPerUnit / 100;
      this.s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
      this.L = this.s.laps || track.laps;
      this.base = track.base_lap;
      this.scale = this.base / 90;
      let thr = 0.3 * Math.exp(6 * (track.overtaking_rho - 0.6));
      if (track.street && !track.semi_street) thr *= 1.25;
      this.passThr = thr * this.scale;
      this.pitLoss = track.pit_loss;
      this.planPitLoss = this.pitLoss + 6 * Math.max(0, thr / 0.9 - 1) * this.scale;
      this.incMult = track.incident_rate;
      this.street = !!track.street;
    }

    weatherScript(rng) {
      const L = this.L;
      let mode = this.s.weather;
      if (mode === "random") {
        mode = rng.random() < this.track.rain_chance ? (rng.random() < 0.35 ? "wet" : "mixed") : "dry";
      }
      const inten = new Float64Array(L + 1);
      if (mode === "wet") {
        const dur = Math.floor(L * rng.uniform(0.25, 0.75)), lvl = rng.uniform(0.55, 0.95);
        for (let i = 0; i <= Math.min(dur, L); i++) inten[i] = lvl;
        if (rng.random() < 0.3) {
          const a = Math.floor(rng.uniform(0.6, 0.85) * L), d = rng.integers(4, 12), l2 = rng.uniform(0.3, 0.7);
          for (let i = a; i < Math.min(a + d, L + 1); i++) inten[i] = l2;
        }
      } else if (mode === "mixed") {
        const a = Math.floor(rng.uniform(0.2, 0.75) * L), d = rng.integers(5, 22), l = rng.uniform(0.3, 0.9);
        for (let i = a; i < Math.min(a + d, L + 1); i++) inten[i] = l;
      }
      const wet = new Float64Array(L + 1);
      let w = mode === "wet" ? inten[0] * rng.uniform(0.85, 1.0) : 0;
      const dryRate = rng.uniform(0.035, 0.075);
      for (let lap = 0; lap <= L; lap++) {
        if (inten[lap] > 0) w += (inten[lap] - w) * 0.35;
        else w = Math.max(0, w - dryRate);
        wet[lap] = w;
      }
      return { mode, wet, raining: Array.from(inten, (x) => x > 0) };
    }

    run(rng, record = false) {
      const s = this.s, L = this.L, E = this.E, n = E.length;
      const { mode: weather, wet, raining } = this.weatherScript(rng);
      const events = [];
      const drv = E.map((e) => e.driverUnits), wetSkill = E.map((e) => e.wetUnits || 0);
      const form = E.map(() => rng.normal(0, s.formSd));
      const roll = {};
      E.forEach((e) => { const id = e.carId || e.key; if (!(id in roll)) roll[id] = rng.normal(0, s.carFormSd); });
      const car = E.map((e) => e.carUnits + roll[e.carId || e.key]);
      const dayWear = Math.exp(rng.normal(0, s.dayWearSd)) * this.track.tyre_wear;
      const wear = E.map(() => dayWear * Math.exp(rng.normal(0, s.carWearSd)));
      const callBias = E.map(() => rng.normal(0, 0.05));
      const paceUnits = (w) => E.map((_, i) => car[i] * (1 - 0.25 * w) + (drv[i] + form[i]) * (1 + 0.35 * w) + wetSkill[i] * w * 1.5);

      // qualifying
      const w0 = wet[0];
      const qu = paceUnits(w0);
      const qTime = E.map((e, i) => {
        let t = this.base * (1 + this.k * (REF_PACE - (qu[i] - form[i] * 0.5)));
        t += this.base * rng.normal(0, (s.qualiSdPct / 100) * (1 + 2 * w0));
        if (rng.random() < s.qualiMishap) {
          t += this.base * rng.uniform(0.005, 0.03);
          if (record && e.isUser) events.push([0, `Qualifying goes wrong for ${e.label}`]);
        }
        return t;
      });
      const gridPos = new Array(n);
      argsort(qTime).forEach((i, p) => { gridPos[i] = p + 1; });

      // race state
      let total = gridPos.map((g) => GRID_SLOT_GAP * (g - 1));
      // replay trace: when each car crosses the line, its tyre each lap, its pit laps, flag state
      const trace = record ? { start: total.slice(), lapEnd: E.map(() => []), tyres: E.map(() => []),
                               pits: E.map(() => []), neutral: [] } : null;
      const running = Array(n).fill(true), lapsDone = Array(n).fill(0);
      const dnfReason = Array(n).fill(null), dnfLap = Array(n).fill(null);
      const stops = Array(n).fill(0), lapsLed = Array(n).fill(0), bestLap = Array(n).fill(Infinity);
      const tyreHist = E.map(() => []), used = Array(n).fill("");
      const plans = Array(n).fill(null), stintEnd = Array(n).fill(0), compound = Array(n).fill("S");
      const age = Array(n).fill(0);
      const startClass = bestTyreFor(w0);
      for (let i = 0; i < n; i++) {
        if (startClass === "S") {
          const p = choosePlan(L, wear[i], this.planPitLoss, this.scale, "", rng);
          plans[i] = p.stints.map((x) => x.slice());
          compound[i] = plans[i][0][0];
          stintEnd[i] = plans[i].length > 1 ? plans[i][0][1] : 0;
        } else {
          compound[i] = startClass; used[i] = "*"; plans[i] = []; stintEnd[i] = 0;
        }
        tyreHist[i].push(compound[i]);
      }
      let scLeft = 0, vscLeft = 0, nSc = 0, nVsc = 0;
      if (w0 > 0.78) {
        scLeft = rng.integers(2, 5); nSc++;
        events.push([1, "The race starts behind the safety car on a soaked track"]);
      }
      const positions = record ? E.map(() => []) : null;
      const maxWet = Math.max(...wet);
      const mistakeLap = E.map(() => (rng.random() < s.raceMistake * (1 + 2 * maxWet) ? rng.integers(1, L + 1) : -1));
      const crashLap = s.crashRate / (L + s.lap1CrashMult - 1);

      const replan = (i, lap) => {
        const left = L - lap;
        if (left <= 0) { plans[i] = []; stintEnd[i] = 0; return; }
        const p = choosePlan(left, wear[i], this.planPitLoss, this.scale, used[i], rng, 1.5);
        plans[i] = p.stints.map((x) => x.slice());
        stintEnd[i] = plans[i].length > 1 ? lap + plans[i][0][1] : 0;
      };
      const retire = (i, lap, reason) => {
        running[i] = false; dnfReason[i] = reason; dnfLap[i] = lap;
        events.push([lap, E[i].isUser || reason === "Accident" ? `${E[i].label} retires: ${reason.toLowerCase()}` : `${E[i].label} retires (${reason.toLowerCase()})`]);
        if (!s.safetyCar || scLeft > 0) { if (scLeft > 0) scLeft++; return; }
        const pSc = reason === "Accident" ? (this.street ? 0.8 : 0.45) : (this.street ? 0.15 : 0.08);
        const pVsc = reason === "Accident" ? 0.35 : 0.22;
        const r = rng.random();
        if (r < pSc) { scLeft = rng.integers(3, 6) + (this.street ? 1 : 0); nSc++; events.push([lap, "Safety car deployed"]); }
        else if (r < pSc + (1 - pSc) * pVsc && vscLeft === 0) { vscLeft = rng.integers(1, 4); nVsc++; events.push([lap, "Virtual safety car"]); }
      };

      for (let lap = 1; lap <= L; lap++) {
        const w = wet[lap], lapsLeft = L - lap + 1;
        const neutral = scLeft > 0 ? "SC" : vscLeft > 0 ? "VSC" : null;
        const idx = argsort(total).filter((i) => running[i]);
        if (!idx.length) break;

        // pit decisions
        const pitting = Array(n).fill(false), newComp = Array(n).fill(null);
        for (const i of idx) {
          if (lapsLeft <= 1) break;
          const cur = compound[i], curClass = isDry(cur) ? "S" : cur;
          const target = bestTyreFor(Math.min(1, Math.max(0, w + callBias[i] + (curClass !== "S" ? 0.04 : -0.02))));
          if (target !== curClass && lapsLeft > 2) {
            const gain = (weatherPenalty(cur, w) - weatherPenalty(target, w)) * this.base;
            if (gain * Math.min(lapsLeft, 8) > this.pitLoss * 0.6 || gain > 3) {
              pitting[i] = true; newComp[i] = target === "S" ? null : target; continue;
            }
          }
          if (curClass !== "S") continue;
          const life = COMPOUNDS[cur].life / wear[i];
          const planned = stintEnd[i] > 0 && lap >= stintEnd[i];
          const cheap = neutral !== null && stintEnd[i] > 0 && stintEnd[i] - lap <= 12 && lapsLeft > 5;
          const cliff = age[i] > life + 3 && lapsLeft > 6;
          if (planned || cheap || cliff) pitting[i] = true;
        }

        // lap times
        const units = paceUnits(w), lt = Array(n).fill(0);
        for (const i of idx) {
          let t = this.base * (1 + this.k * (REF_PACE - units[i]));
          t += lapCost(compound[i], age[i], isDry(compound[i]) ? wear[i] : 1, this.scale);
          t += this.base * (weatherPenalty(compound[i], w) + 0.1 * w);
          t += 0.055 * this.scale * (lapsLeft - 1);
          t += this.base * rng.normal(0, (s.lapSdPct / 100) * (1 + 1.5 * w));
          if (lap === 1) t += START_LOSS + Math.abs(rng.normal(0, 0.35));
          if (lap === mistakeLap[i] && s.incidents) {
            const loss = rng.uniform(4, 18);
            t += loss;
            if (record && E[i].isUser) events.push([lap, `${E[i].label} runs wide and loses ${Math.round(loss)}s`]);
          }
          lt[i] = t;
        }
        const pitCost = Array(n).fill(0);
        for (const i of idx) {
          if (!pitting[i]) continue;
          const f = neutral === "SC" ? SC_PIT : neutral === "VSC" ? VSC_PIT : 1;
          let c = this.pitLoss * f + Math.abs(rng.normal(0, 0.5));
          if (rng.random() < 0.03) {
            c += rng.uniform(3, 9);
            if (E[i].isUser) events.push([lap, `Slow stop for ${E[i].label} (+${(c - this.pitLoss * f).toFixed(1)}s)`]);
          }
          pitCost[i] = c;
        }

        // move the cars
        const nt = total.slice();
        if (neutral === "SC") {
          let prev = -1;
          for (const i of idx) {
            nt[i] = prev < 0 ? total[i] + this.base * SC_LAP : nt[prev] + Math.max(0.5, (total[i] - total[prev]) * 0.35);
            prev = i;
          }
          for (const i of idx) nt[i] += pitCost[i];
        } else if (neutral === "VSC") {
          for (const i of idx) nt[i] = total[i] + this.base * VSC_LAP + pitCost[i] + rng.normal(0, 0.15);
        } else {
          const thr = this.passThr * (1 - 0.35 * w) * (lap === 1 ? 0.5 : 1);
          idx.forEach((i, pos) => {
            let tNew = total[i] + lt[i] + pitCost[i];
            if (pos > 0 && !pitting[i]) {
              const a = idx[pos - 1], gap0 = total[i] - total[a], close = lap === 1 ? 3 : 1.5;
              if (gap0 < close && tNew < nt[a] + 0.25 && !pitting[a]) {
                let p = sigmoid((lt[a] - lt[i] - thr) / (0.25 * this.scale));
                if (lap === 1) p = Math.max(p, 0.25);
                if (rng.random() < p) tNew = Math.min(tNew, nt[a] - 0.1);
                else tNew = Math.max(tNew, nt[a] + rng.uniform(0.25, 0.7));
              }
            }
            nt[i] = tNew;
          });
        }
        total = nt;

        if (record) {
          trace.neutral.push(neutral);
          for (const i of idx) { trace.tyres[i].push(compound[i]); if (pitting[i]) trace.pits[i].push(lap); }
        }
        // tyres after stops
        for (const i of idx) {
          if (pitting[i]) {
            stops[i]++;
            if (newComp[i] !== null) { compound[i] = newComp[i]; used[i] = "*"; plans[i] = []; stintEnd[i] = 0; }
            else {
              if (isDry(compound[i]) && used[i] !== "*" && !used[i].includes(compound[i])) used[i] += compound[i];
              replan(i, lap);
              compound[i] = plans[i].length ? plans[i][0][0] : "H";
            }
            age[i] = 0;
            tyreHist[i].push(compound[i]);
          } else age[i]++;
          if (isDry(compound[i]) && used[i] !== "*" && !used[i].includes(compound[i])) used[i] += compound[i];
        }

        // incidents
        if (s.incidents) {
          for (const i of idx) {
            if (!running[i]) continue;
            if (neutral === null) {
              let h = crashLap * E[i].crashMult * this.incMult * (1 + 3 * w);
              if (lap === 1) h *= s.lap1CrashMult;
              if (rng.random() < h) { retire(i, lap, "Accident"); continue; }
            }
            const hm = -Math.log(Math.max(1e-9, 1 - E[i].mechRate)) / L;
            if (rng.random() < hm) retire(i, lap, rng.pick(FAILURES));
          }
          if (s.safetyCar && scLeft === 0 && vscLeft === 0 && rng.random() < 0.002 * (1 + 2 * w)) {
            if (rng.random() < 0.5) { scLeft = rng.integers(2, 5); nSc++; events.push([lap, "Safety car: debris on track"]); }
            else { vscLeft = rng.integers(1, 3); nVsc++; events.push([lap, "Virtual safety car: car recovery"]); }
          }
        }

        if (record) {
          if (raining[lap] && !raining[lap - 1]) events.push([lap, "Rain starts to fall"]);
          if (!raining[lap] && raining[lap - 1]) events.push([lap, "The rain stops and the track starts to dry"]);
          const fieldPits = {};
          for (const i of idx) {
            if (!pitting[i] || !running[i]) continue;
            const nm = COMPOUNDS[compound[i]].name;
            if (E[i].isUser) events.push([lap, `${E[i].label} pits for ${nm.toLowerCase()}s`]);
            else fieldPits[nm] = (fieldPits[nm] || 0) + 1;
          }
          for (const [nm, c] of Object.entries(fieldPits)) if (c >= 3) events.push([lap, `${c} other cars pit for ${nm.toLowerCase()}s`]);
        }

        for (const i of idx) if (running[i]) {
          lapsDone[i] = lap;
          if (record) trace.lapEnd[i].push(total[i]);
          if (neutral === null && lap > 1 && lt[i] < bestLap[i]) bestLap[i] = lt[i];
        }
        const runIdx = argsort(total).filter((i) => running[i]);
        if (runIdx.length) lapsLed[runIdx[0]]++;
        if (scLeft > 0) { scLeft--; if (scLeft === 0) events.push([lap, "Safety car in, racing resumes"]); }
        else if (vscLeft > 0) vscLeft--;
        if (record) {
          const order = runIdx.concat([...Array(n).keys()].filter((i) => !running[i]));
          order.forEach((i, p) => positions[i].push(running[i] ? p + 1 : null));
        }
      }

      const fin = [...Array(n).keys()].sort((a, b) => (lapsDone[b] - lapsDone[a]) || (total[a] - total[b]));
      const cars = {};
      fin.forEach((i, p) => {
        cars[E[i].key] = {
          position: p + 1, grid: gridPos[i], finished: running[i], laps: lapsDone[i], totalTime: total[i],
          dnfReason: dnfReason[i], dnfLap: dnfLap[i], stops: stops[i], tyres: tyreHist[i],
          lapsLed: lapsLed[i], bestLap: bestLap[i],
        };
      });
      events.sort((a, b) => a[0] - b[0]);
      const pos = {};
      let tr = null;
      if (record) {
        E.forEach((e, i) => { pos[e.key] = positions[i]; });
        tr = { neutral: trace.neutral, cars: {} };
        E.forEach((e, i) => { tr.cars[e.key] = { start: trace.start[i], lapEnd: trace.lapEnd[i], tyres: trace.tyres[i], pits: trace.pits[i] }; });
      }
      return { order: fin.map((i) => E[i].key), cars, weather, safetyCars: nSc, vscs: nVsc, events,
               positions: record ? pos : null, wetness: record ? Array.from(wet) : null, trace: tr, laps: L };
    }
  }

  // ------------------------------------------------------------------ model
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  // inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9)
  function invNorm(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function searchsortedRight(edges, x) { let i = 0; while (i < edges.length && edges[i] <= x) i++; return i; }

  class Model {
    constructor(ratings, tracks) {
      this.meta = ratings.meta;
      this.drivers = ratings.drivers;
      this.cars = ratings.cars;
      this.eras = ratings.eras;
      this.eraSim = ratings.era_similarity;
      this.ageCurve = ratings.age_curve;
      this.expCurve = ratings.experience_curve;
      this.tracks = tracks.tracks;
      this.pctPerUnit = ratings.meta.calibration.pct_per_unit;
      const modern = Object.values(this.cars).filter((c) => c.year >= 2022 && c.year <= 2025).map((c) => c.mech_rate).sort((a, b) => a - b);
      this.modernMech = modern.length ? (modern.length % 2 ? modern[(modern.length - 1) / 2] : (modern[modern.length / 2 - 1] + modern[modern.length / 2]) / 2) : 0.06;
      this.years = [...new Set(Object.values(this.cars).map((c) => c.year))].sort((a, b) => b - a);
    }
    eraFor(year) {
      for (const e of this.eras) if (year >= e.start && year <= e.end) return e;
      return year > this.eras[this.eras.length - 1].end ? this.eras[this.eras.length - 1] : this.eras[0];
    }
    eraName(e) { return `${e.name} (${e.start}–${Math.min(e.end, 2026)})`; }
    carLabel(key) { const c = this.cars[key]; return `${c.team} ${c.year}`; }
    carsInYear(year) {
      return Object.keys(this.cars).filter((k) => this.cars[k].year === +year).sort((a, b) => this.cars[b].rating - this.cars[a].rating);
    }
    defaultCar(ref, year) {
      const own = (this.drivers[ref].teams_by_year[String(year)] || [])[0];
      if (own && this.cars[`${own}@${year}`]) return `${own}@${year}`;
      return this.carsInYear(year)[0];
    }
    bestYear(ref) {
      let best = null, br = -Infinity;
      for (const [y, teams] of Object.entries(this.drivers[ref].teams_by_year)) {
        const c = this.cars[`${teams[0]}@${y}`];
        if (c && c.rating > br) { br = c.rating; best = +y; }
      }
      return best;
    }
    ageEffect(ref, year, peak) {
      const d = this.drivers[ref], eff = this.ageCurve.effects;
      if (!peak && d.starts_by_year[String(year)] && d.dob) {
        const age = (Date.UTC(year, 6, 1) - Date.parse(d.dob + "T00:00:00Z")) / (365.25 * 864e5);
        const b = Math.min(Math.max(searchsortedRight(this.ageCurve.edges, age) - 1, 0), eff.length - 1);
        return [eff[b], `age ${Math.round(age)} in ${year}`];
      }
      const bins = d.age_bins && d.age_bins.length ? d.age_bins : eff.map((_, i) => i);
      const b = bins.reduce((x, y) => (eff[y] > eff[x] ? y : x), bins[0]);
      return [eff[b], `at their peak (age ${this.ageCurve.labels[b]})`];
    }
    expEffect(ref, year, peak) {
      const d = this.drivers[ref], sby = d.starts_by_year, eff = this.expCurve.effects;
      if (peak || !sby[String(year)]) return Math.max(...eff);
      let before = sby[String(year)] / 2;
      for (const [y, v] of Object.entries(sby)) if (+y < year) before += v;
      const b = Math.min(Math.max(searchsortedRight(this.expCurve.edges, before) - 1, 0), eff.length - 1);
      return eff[b];
    }
    affinity(ref, eraKey) {
      const d = this.drivers[ref];
      if (d.eras[eraKey]) return [d.eras[eraKey].affinity, `raced ${d.eras[eraKey].starts} Grands Prix in this era`];
      const keys = this.eras.map((e) => e.key), j = keys.indexOf(eraKey);
      let num = 0, den = 0.5, best = null;
      for (const [k, a] of Object.entries(d.eras)) {
        const i = keys.indexOf(k), conf = a.starts / (a.starts + 20), wgt = this.eraSim[j][i] * conf;
        num += wgt * a.affinity; den += wgt;
        if (!best || this.eraSim[j][i] > best[0]) best = [this.eraSim[j][i], this.eras[i].name];
      }
      return [num / den, best ? `never raced these cars; estimated mostly from the ${best[1]} era` : "estimated"];
    }
    entry(ref, carKey, peak = false) {
      const d = this.drivers[ref], c = this.cars[carKey], era = this.eraFor(c.year);
      const [aff, affSrc] = this.affinity(ref, era.key);
      const [ageEff, ageNote] = this.ageEffect(ref, c.year, peak);
      const expEff = this.expEffect(ref, c.year, peak);
      const priv = (c.entries || {})[ref] || 0;
      const b = {
        driverRef: ref, driverName: d.name, code: d.code, carKey, carLabel: this.carLabel(carKey), year: c.year,
        eraKey: era.key, eraName: this.eraName(era), skill: d.skill, affinity: aff, affinitySource: affSrc,
        ageEffect: ageEff, ageNote, experienceEffect: expEff, car: c.rating, privateerOffset: priv,
        wet: d.wet, crashRatio: Math.min(1.8, Math.max(0.5, d.crash_ratio)), mechRate: c.mech_rate,
      };
      b.driverUnits = b.skill + b.affinity + b.ageEffect + b.experienceEffect;
      b.carUnits = b.car + b.privateerOffset;
      b.total = b.driverUnits + b.carUnits;
      return b;
    }
    mech(b, reliability) { return reliability === "era" ? b.mechRate : reliability === "off" ? 0 : this.modernMech; }
    simEntries(bds, reliability) {
      const seen = {};
      return bds.map((b, i) => {
        let key = `${b.driverRef}@${b.carKey}`;
        seen[key] = (seen[key] || 0) + 1;
        if (seen[key] > 1) key += `#${seen[key]}`;
        return { key, label: `${b.driverName} (${b.carLabel})`, name: b.driverName, car: b.carLabel, short: b.code,
                 driverUnits: b.driverUnits, carUnits: b.carUnits, wetUnits: b.wet, crashMult: b.crashRatio,
                 mechRate: this.mech(b, reliability), isUser: true, color: PALETTE[i % PALETTE.length], carId: b.carKey };
      });
    }
    fieldEntries(n, seed, year, exclude, reliability) {
      const out = [];
      if (year) {
        for (const ck of this.carsInYear(year)) {
          for (const dref of this.cars[ck].drivers.slice(0, 2)) {
            if (exclude.has(dref) || out.length >= n || !this.drivers[dref]) continue;
            const b = this.entry(dref, ck);
            out.push({ key: `field:${dref}`, label: `${b.driverName} (${b.carLabel})`, name: b.driverName, car: b.carLabel,
                       short: b.code, driverUnits: b.driverUnits, carUnits: b.carUnits, wetUnits: b.wet,
                       crashMult: b.crashRatio, mechRate: this.mech(b, reliability), isUser: false, carId: ck });
          }
        }
        return out;
      }
      // anonymous field: evenly spaced quantiles of a modern season's spread (deterministic)
      const f = this.meta.field, k = Math.ceil(n / 2);
      const cars = Array.from({ length: k }, (_, j) => f.car_mean + f.car_sd * invNorm(1 - (j + 0.5) / k));
      for (let i = 0; i < n; i++) {
        out.push({ key: `field:${i + 1}`, label: `Field car ${i + 1}`, name: `Field car ${i + 1}`, car: "", short: `F${i + 1}`,
                   driverUnits: f.driver_mean + f.driver_sd * invNorm(1 - (i + 0.5) / n), carUnits: cars[Math.floor(i / 2)], wetUnits: 0,
                   crashMult: 1, mechRate: reliability === "off" ? 0 : this.modernMech, isUser: false, carId: `field-car-${Math.floor(i / 2)}` });
      }
      return out;
    }
  }

  // ------------------------------------------------------------------ Monte Carlo
  function setup(model, bds, trackRef, opts) {
    const o = Object.assign({ nSims: 1000, settings: {}, fieldSize: 20, fieldYear: null, reliability: "modern", seed: 2026 }, opts || {});
    const track = model.tracks[trackRef];
    const users = model.simEntries(bds, o.reliability);
    const field = model.fieldEntries(Math.max(0, o.fieldSize - users.length), o.seed, o.fieldYear,
                                     new Set(bds.map((b) => b.driverRef)), o.reliability);
    const entries = users.concat(field);
    const sim = new RaceSimulator(track, entries, model.pctPerUnit, o.settings);
    const entryInfo = {};
    entries.forEach((e) => { entryInfo[e.key] = { label: e.label, name: e.name, car: e.car, short: e.short, isUser: e.isUser, color: e.color || null }; });
    return { o, track, users, entries, sim, entryInfo };
  }

  // one recorded race (for the replay's "watch another race")
  function sampleRace(model, bds, trackRef, opts, seed) {
    const { sim, entryInfo } = setup(model, bds, trackRef, opts);
    return { sample: sim.run(makeRng(seed), true), entryInfo };
  }

  function simulate(model, bds, trackRef, opts, progress) {
    const { o, track, users, entries, sim, entryInfo } = setup(model, bds, trackRef, opts);
    const rng = makeRng(o.seed);
    const keys = users.map((u) => u.key), N = o.nSims, nCars = entries.length;
    const pos = keys.map(() => new Int16Array(N)), dnf = keys.map(() => new Uint8Array(N));
    const stops = keys.map(() => new Int16Array(N)), grid = keys.map(() => new Int16Array(N)), led = keys.map(() => new Int16Array(N));
    const weather = { dry: 0, wet: 0, mixed: 0 };
    let sc = 0, vsc = 0;
    for (let r = 0; r < N; r++) {
      const res = sim.run(rng);
      weather[res.weather]++;
      if (res.safetyCars > 0) sc++;
      if (res.vscs > 0) vsc++;
      keys.forEach((k, j) => {
        const c = res.cars[k];
        pos[j][r] = c.position; dnf[j][r] = c.finished ? 0 : 1; stops[j][r] = c.stops; grid[j][r] = c.grid; led[j][r] = c.lapsLed;
      });
      if (progress && (r % 25 === 0 || r === N - 1)) progress((r + 1) / N);
    }
    const bestUser = new Int16Array(N);
    for (let r = 0; r < N; r++) {
      let b = 0;
      for (let j = 1; j < keys.length; j++) if (pos[j][r] < pos[b][r]) b = j;
      bestUser[r] = b;
    }
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const share = (a, f) => { let c = 0; for (const x of a) if (f(x)) c++; return c / a.length; };
    let rows = keys.map((k, j) => {
      const fin = [];
      for (let r = 0; r < N; r++) if (!dnf[j][r]) fin.push(stops[j][r]);
      const counts = new Array(nCars).fill(0);
      for (const p of pos[j]) counts[p - 1]++;
      return {
        key: k, name: users[j].name, car: users[j].car, color: users[j].color, short: users[j].short,
        beatsAll: share(bestUser, (x) => x === j), win: share(pos[j], (p) => p === 1), podium: share(pos[j], (p) => p <= 3),
        points: share(pos[j], (p) => p <= 10), avgPos: mean(pos[j]), avgGrid: mean(grid[j]), pole: share(grid[j], (g) => g === 1),
        dnf: mean(dnf[j]), avgStops: fin.length ? mean(fin) : 0, lapsLed: mean(led[j]), counts,
      };
    });
    const h2h = {};
    keys.forEach((a, i) => keys.forEach((b, j) => {
      if (i === j) return;
      let c = 0; for (let r = 0; r < N; r++) if (pos[i][r] < pos[j][r]) c++;
      h2h[a + ">" + b] = c / N;
    }));
    const inputOrder = rows.slice();
    rows = rows.slice().sort((a, b) => (b.beatsAll - a.beatsAll) || (a.avgPos - b.avgPos));
    const sample = sim.run(makeRng(o.seed + 1), true);
    return { track, trackRef, nSims: N, rows, inputOrder, h2h, keys, weatherShare: { dry: weather.dry / N, wet: weather.wet / N, mixed: weather.mixed / N },
             scShare: sc / N, vscShare: vsc / N, breakdowns: bds, sample, fieldSize: nCars, entryInfo };
  }

  const api = { makeRng, COMPOUNDS, optimise, wearBucket, RaceSimulator, Model, simulate, sampleRace, PALETTE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.F1Sim = api;
})(typeof self !== "undefined" ? self : this);
