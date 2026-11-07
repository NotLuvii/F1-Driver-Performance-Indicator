/* Page logic: build the grid, run simulations in a worker, draw the race report. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  };
  const pct = (x, d = 0) => (x > 0 && x < 0.005 && d === 0 ? "<1%" : `${(100 * x).toFixed(d)}%`);
  const fmtInt = (x) => x.toLocaleString("en-US");
  const MAX_SLOTS = 8;
  const DEFAULT_SLOTS = [["senna", 1988], ["max_verstappen", 2023], ["hamilton", 2020], ["michael_schumacher", 2004]];
  const RAMP = ["#184f95", "#3987e5", "#86b6ef", "#cde2fb", "#898781"];
  const RAMP_TEXT = ["#fff", "#fff", "#16191d", "#16191d", "#fff"];
  const BANDS = ["Win", "Podium (P2–P3)", "Points (P4–P10)", "P11 or lower", "Did not finish"];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let M = null;
  let worker = null;
  let runId = 0;
  let lastSummary = null;
  let lastRun = null;
  let circuits = {};
  let replay = null;
  let lapCursor = null;
  const state = {
    track: "silverstone", weather: "random", reliability: "modern", field: "generic", sims: 1000,
    safetyCar: true, peak: false, sameCar: null, slots: [],
  };
  const nameToRef = new Map();
  const refToName = (ref) => {
    const d = M.drivers[ref];
    return `${d.name} (${d.first_year}–${d.last_year})`;
  };

  // ------------------------------------------------------------------ setup
  async function init() {
    try {
      const [r, t] = await Promise.all([fetch("data/ratings.json"), fetch("data/tracks.json")]);
      M = new F1Sim.Model(await r.json(), await t.json());
      fetch("data/circuits.json").then((c) => c.json()).then((c) => { circuits = c.circuits || {}; }).catch(() => {});
    } catch (e) {
      $("status").textContent = "Couldn't load the ratings data. Reload the page to try again.";
      return;
    }
    try { worker = new Worker("worker.js"); } catch (e) { worker = null; }

    // drivers datalist
    const refs = Object.keys(M.drivers).filter((r) => M.drivers[r].starts >= 3)
      .sort((a, b) => M.drivers[b].starts - M.drivers[a].starts);
    const dl = $("driver-list");
    for (const r of refs) { nameToRef.set(refToName(r), r); dl.append(el("option", { value: refToName(r) })); }

    // circuits
    const tracks = Object.entries(M.tracks).sort((a, b) => (b[1].last_year - a[1].last_year) || a[1].grand_prix.localeCompare(b[1].grand_prix));
    const cur = el("optgroup", { label: "On the current calendar" }), old = el("optgroup", { label: "Past circuits" });
    for (const [ref, t] of tracks) {
      const label = `${t.grand_prix.replace(" Grand Prix", "")}: ${t.name}` + (t.last_year >= 2025 ? "" : ` (last raced ${t.last_year})`);
      (t.last_year >= 2025 ? cur : old).append(el("option", { value: ref, text: label }));
    }
    $("track").append(cur, old);

    // rest of grid
    const f = $("field");
    f.append(el("option", { value: "generic", text: "Typical modern midfield" }));
    const seasons = el("optgroup", { label: "A real season's grid" });
    for (const y of M.years) seasons.append(el("option", { value: String(y), text: `The ${y} grid` }));
    f.append(seasons, el("option", { value: "none", text: "Nobody (only your drivers)" }));

    // same-car pickers
    for (const y of M.years) $("same-year").append(el("option", { value: y, text: y }));

    readHash();
    if (!state.slots.length) state.slots = DEFAULT_SLOTS.map(([d, y]) => ({ driver: d, year: y, car: M.defaultCar(d, y) }));
    syncControls();
    renderSlots();

    $("track").addEventListener("change", (e) => { state.track = e.target.value; trackNote(); });
    $("weather").addEventListener("change", (e) => { state.weather = e.target.value; });
    $("reliability").addEventListener("change", (e) => { state.reliability = e.target.value; });
    $("field").addEventListener("change", (e) => { state.field = e.target.value; });
    $("sims").addEventListener("change", (e) => { state.sims = +e.target.value; });
    $("safety-car").addEventListener("change", (e) => { state.safetyCar = e.target.checked; });
    $("peak").addEventListener("change", (e) => { state.peak = e.target.checked; });
    $("same-car").addEventListener("change", (e) => {
      state.sameCar = e.target.checked ? (state.sameCar || "red_bull@2023") : null;
      if (e.target.checked) state.peak = $("peak").checked = true;
      syncSameCar(); renderSlots();
    });
    $("same-year").addEventListener("change", (e) => {
      state.sameCar = M.carsInYear(+e.target.value)[0]; syncSameCar();
    });
    $("same-team").addEventListener("change", (e) => { state.sameCar = e.target.value; });
    $("go").addEventListener("click", run);
    $("share").addEventListener("click", share);
    if (location.hash.includes("e=")) run();
  }

  function syncControls() {
    $("track").value = state.track; $("weather").value = state.weather; $("reliability").value = state.reliability;
    $("field").value = state.field; $("sims").value = String(state.sims); $("safety-car").checked = state.safetyCar;
    $("peak").checked = state.peak; $("same-car").checked = !!state.sameCar;
    syncSameCar(); trackNote();
  }
  function syncSameCar() {
    const on = !!state.sameCar;
    $("same-car-pick").hidden = !on;
    $("slots").classList.toggle("same-car", on);
    if (!on) return;
    const y = M.cars[state.sameCar].year;
    $("same-year").value = y;
    const t = $("same-team");
    t.replaceChildren(...M.carsInYear(y).map((k) => el("option", { value: k, text: `${M.cars[k].team}, car rating ${signed(M.cars[k].rating)}` })));
    t.value = state.sameCar;
  }
  function trackNote() {
    const t = M.tracks[state.track];
    $("track-note").textContent = `${t.laps} laps, fastest laps around ${t.base_lap.toFixed(1)}s, about ${t.pit_loss.toFixed(0)}s lost per pit stop. ` +
      `It has rained in ${Math.round(t.rain_chance * 100)}% of races here.`;
  }
  const signed = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);

  // ------------------------------------------------------------------ grid slots
  function renderSlots() {
    const ol = $("slots");
    ol.replaceChildren();
    state.slots.forEach((slot, i) => ol.append(slotView(slot, i)));
    if (state.slots.length < MAX_SLOTS) {
      ol.append(el("li", { class: "slot add" },
        el("button", { class: "add-btn", type: "button", onclick: addSlot }, "Add a driver to the grid")));
    }
  }
  function addSlot() {
    const used = new Set(state.slots.map((s) => s.driver));
    const pick = ["alonso", "clark", "fangio", "prost", "vettel", "lauda", "leclerc", "norris"].find((r) => !used.has(r)) || "alonso";
    const y = M.bestYear(pick);
    state.slots.push({ driver: pick, year: y, car: M.defaultCar(pick, y) });
    renderSlots();
    const inputs = $("slots").querySelectorAll("input.driver");
    inputs[inputs.length - 1].focus();
    inputs[inputs.length - 1].select();
  }
  function slotView(slot, i) {
    const id = `slot-${i}`;
    const err = el("p", { class: "slot-err", hidden: true });
    const driver = el("input", { type: "text", class: "driver", list: "driver-list", id: `${id}-driver`, value: refToName(slot.driver),
      "aria-label": `Grid position ${i + 1}: driver`, autocomplete: "off", spellcheck: "false" });
    const year = el("select", { class: "year", "aria-label": `Grid position ${i + 1}: car year` });
    const car = el("select", { class: "car", "aria-label": `Grid position ${i + 1}: car` });
    const fill = () => {
      const d = M.drivers[slot.driver];
      const theirs = Object.keys(d.teams_by_year).map(Number).sort((a, b) => b - a);
      const g1 = el("optgroup", { label: "Seasons they raced" }, theirs.map((y) => el("option", { value: y, text: y })));
      const g2 = el("optgroup", { label: "Any season" }, M.years.filter((y) => !theirs.includes(y)).map((y) => el("option", { value: y, text: y })));
      year.replaceChildren(g1, g2);
      year.value = slot.year;
      const own = d.teams_by_year[String(slot.year)] || [];
      car.replaceChildren(...M.carsInYear(slot.year).map((k) => el("option", { value: k,
        text: `${M.cars[k].team}${own.includes(M.cars[k].team_ref) ? " (their car)" : ""}, rating ${signed(M.cars[k].rating)}` })));
      car.value = slot.car;
    };
    fill();
    driver.addEventListener("change", () => {
      const ref = nameToRef.get(driver.value.trim()) || fuzzy(driver.value);
      if (!ref) { err.hidden = false; err.textContent = "Pick a driver from the list."; return; }
      err.hidden = true;
      slot.driver = ref; driver.value = refToName(ref);
      slot.year = M.bestYear(ref); slot.car = M.defaultCar(ref, slot.year);
      fill();
    });
    year.addEventListener("change", () => { slot.year = +year.value; slot.car = M.defaultCar(slot.driver, slot.year); fill(); });
    car.addEventListener("change", () => { slot.car = car.value; });
    const remove = state.slots.length > 1
      ? el("button", { class: "slot-remove", type: "button", "aria-label": `Remove ${M.drivers[slot.driver].name} from the grid`,
          onclick: () => { state.slots.splice(i, 1); renderSlots(); } }, "×")
      : null;
    return el("li", { class: "slot" }, el("span", { class: "slot-num", "aria-hidden": "true" }, String(i + 1)), remove,
      el("div", { class: "slot-fields" }, driver, car, year), err);
  }
  function fuzzy(text) {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    let best = null;
    for (const [name, ref] of nameToRef) {
      if (name.toLowerCase().includes(q) && (!best || M.drivers[ref].starts > M.drivers[best].starts)) best = ref;
    }
    return best;
  }

  // ------------------------------------------------------------------ URL state
  function writeHash() {
    const p = new URLSearchParams({ t: state.track, w: state.weather, r: state.reliability, f: state.field, n: state.sims,
      sc: state.safetyCar ? 1 : 0, pk: state.peak ? 1 : 0, e: state.slots.map((s) => `${s.driver}:${s.car}`).join(",") });
    if (state.sameCar) p.set("same", state.sameCar);
    history.replaceState(null, "", "#" + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("t") && M.tracks[p.get("t")]) state.track = p.get("t");
    if (["random", "dry", "wet", "mixed"].includes(p.get("w"))) state.weather = p.get("w");
    if (["modern", "era", "off"].includes(p.get("r"))) state.reliability = p.get("r");
    if (p.get("f")) state.field = p.get("f");
    if (p.get("n") && +p.get("n") > 0) state.sims = Math.min(5000, +p.get("n"));
    if (p.get("sc")) state.safetyCar = p.get("sc") === "1";
    if (p.get("pk")) state.peak = p.get("pk") === "1";
    if (p.get("same") && M.cars[p.get("same")]) state.sameCar = p.get("same");
    if (p.get("e")) {
      state.slots = p.get("e").split(",").map((x) => x.split(":")).filter(([d, c]) => M.drivers[d] && M.cars[c])
        .slice(0, MAX_SLOTS).map(([d, c]) => ({ driver: d, car: c, year: M.cars[c].year }));
    }
  }
  async function share() {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); $("share").textContent = "Link copied"; }
    catch (e) { $("share").textContent = "Copy the address bar to share"; }
    setTimeout(() => { $("share").textContent = "Copy link to this race"; }, 2500);
  }

  // ------------------------------------------------------------------ running
  function setLights(n) {
    [...$("lights").children].forEach((s, i) => s.classList.toggle("on", i < n));
  }
  function run() {
    if (!M) return;
    writeHash();
    const picks = state.slots.map((s) => ({ driver: s.driver, car: state.sameCar || s.car, peak: state.peak }));
    const options = {
      nSims: state.sims, settings: { weather: state.weather, safetyCar: state.safetyCar },
      fieldSize: state.field === "none" ? 0 : 20, fieldYear: /^\d{4}$/.test(state.field) ? +state.field : null,
      reliability: state.reliability, seed: 2026,
    };
    const id = ++runId;
    lastRun = { picks, options, track: state.track };
    $("go").disabled = true;
    setLights(0);
    $("status").textContent = `Racing… 0 of ${fmtInt(state.sims)}`;
    const onProgress = (f) => {
      setLights(Math.min(5, Math.ceil(f * 5)));
      $("status").textContent = `Racing… ${fmtInt(Math.round(f * state.sims))} of ${fmtInt(state.sims)}`;
    };
    const onDone = (summary) => {
      setLights(5);
      setTimeout(() => {
        setLights(0);
        $("go").disabled = false;
        $("status").textContent = "";
        lastSummary = summary;
        renderResults(summary);
        $("results").hidden = false;
        $("results").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }, reduceMotion ? 0 : 450);
    };
    if (worker) {
      worker.onmessage = (ev) => {
        if (ev.data.id !== id) return;
        if (ev.data.type === "progress") onProgress(ev.data.value);
        else if (ev.data.type === "done") onDone(ev.data.summary);
        else if (ev.data.type === "race") return;
        else { $("go").disabled = false; setLights(0); $("status").textContent = `The simulation stopped: ${ev.data.message}`; }
      };
      worker.postMessage({ id, picks, track: state.track, options });
    } else {
      setTimeout(() => {
        const bds = picks.map((p) => M.entry(p.driver, p.car, p.peak));
        onDone(F1Sim.simulate(M, bds, state.track, options, onProgress));
      }, 30);
    }
  }

  // ------------------------------------------------------------------ results
  function renderResults(s) {
    const t = s.track;
    const users = s.inputOrder;
    const color = Object.fromEntries(users.map((u) => [u.key, u.color]));
    $("results-title").textContent = `${t.grand_prix}, ${fmtInt(s.nSims)} times`;
    const rain = s.weatherShare.wet + s.weatherShare.mixed;
    $("conditions").textContent = `${t.name}, ${t.laps} laps. It rained in ${pct(rain)} of the races; ` +
      `the safety car came out in ${pct(s.scShare)} and a virtual safety car in ${pct(s.vscShare)}.`;

    // timing tower
    const tower = $("tower");
    tower.replaceChildren(...s.rows.map((r, i) => el("li", {},
      el("span", { class: "pos" }, String(i + 1)),
      el("span", { class: "stripe", style: `background:${color[r.key]}` }),
      el("div", { class: "who" }, el("strong", {}, r.name), el("span", {}, r.car)),
      el("div", { class: "share" }, el("b", {}, pct(r.beatsAll)),
        el("div", { class: "bar" }, el("i", { style: `width:${(100 * r.beatsAll).toFixed(1)}%;background:${color[r.key]}` }))))));

    // outcome bands
    $("outcome-hint").textContent = `Finishing positions in a ${s.fieldSize}-car field.`;
    $("outcomes").replaceChildren(...s.rows.map((r) => {
      const c = r.counts.map((x) => x / s.nSims);
      const sum = (a, b) => c.slice(a, b).reduce((x, y) => x + y, 0);
      const vals = [c[0] || 0, sum(1, 3), sum(3, 10), 0, r.dnf];
      vals[3] = Math.max(0, 1 - vals[0] - vals[1] - vals[2] - vals[4]);
      return el("div", { class: "outcome-row" },
        el("div", { class: "name" }, r.name, el("span", { style: "color:var(--muted);font-weight:400" }, `, ${r.car}`)),
        el("div", { class: "stack", role: "img", "aria-label": vals.map((v, i) => `${BANDS[i]} ${pct(v)}`).join(", ") },
          vals.map((v, i) => v <= 0 ? null : el("div", { style: `flex:${v} 0 0;background:${RAMP[i]}`, title: `${BANDS[i]}: ${pct(v, 1)}` },
            v >= 0.09 ? el("span", { style: `color:${RAMP_TEXT[i]}` }, pct(v)) : null))));
    }));
    $("outcome-legend").replaceChildren(...BANDS.map((b, i) => el("span", {}, el("i", { style: `background:${RAMP[i]}` }), b)));

    // head to head
    const h = $("h2h");
    const order = s.rows.map((r) => r.key);
    const surname = (r) => r.name.split(" ").slice(-1)[0];
    const dup = (r) => s.rows.filter((q) => surname(q) === surname(r)).length > 1;
    const short = Object.fromEntries(s.rows.map((r) => [r.key, dup(r) ? `${surname(r)} ${r.car.slice(-4)}` : surname(r)]));
    h.replaceChildren(
      el("thead", {}, el("tr", {}, el("th", {}, ""), order.map((k) => el("th", {}, short[k])))),
      el("tbody", {}, order.map((a) => el("tr", {},
        el("th", { scope: "row", style: "text-align:left" }, el("span", { class: "swatch", style: `background:${color[a]}` }), short[a]),
        order.map((b) => {
          if (a === b) return el("td", { style: "color:var(--muted)" }, "–");
          const v = s.h2h[`${a}>${b}`];
          const tint = v >= 0.5 ? `rgba(42,120,214,${((v - 0.5) * 0.7).toFixed(3)})` : `rgba(227,73,72,${((0.5 - v) * 0.7).toFixed(3)})`;
          return el("td", { style: `background:${tint}` }, pct(v));
        })))));

    // pace breakdown
    const k = M.pctPerUnit / 100 * t.base_lap;
    $("pace-hint").textContent = `In rating points. One point is worth about ${k.toFixed(2)}s a lap at ${t.name.replace(/ Circuit$/, "")}. ` +
      "The last column compares each entry with an average car and driver from a modern field.";
    const byKey = Object.fromEntries(users.map((u, i) => [u.key, s.breakdowns[i]]));
    $("pace").replaceChildren(
      el("thead", {}, el("tr", {}, ["Driver and car", "Driver skill", "Era fit", "Age and experience", "Car", "Total", "Wet skill", "Per lap vs average"].map((x) => el("th", {}, x)))),
      el("tbody", {}, s.rows.map((r) => {
        const b = byKey[r.key];
        const sec = b.total * k;
        return el("tr", {},
          el("td", { class: "who" }, el("span", { class: "swatch", style: `background:${color[r.key]}` }), b.driverName, el("span", {}, b.carLabel)),
          el("td", {}, signed(b.skill)), el("td", {}, signed(b.affinity)), el("td", {}, signed(b.ageEffect + b.experienceEffect)),
          el("td", {}, signed(b.carUnits)), el("td", { style: "font-weight:600" }, signed(b.total)), el("td", {}, signed(b.wet)),
          el("td", {}, `${Math.abs(sec).toFixed(2)}s ${sec >= 0 ? "faster" : "slower"}`));
      })));
    $("pace-notes").replaceChildren(...s.rows.map((r) => {
      const b = byKey[r.key];
      return el("li", {}, `${b.driverName}: ${b.eraName} era fit ${signed(b.affinity)} (${b.affinitySource}); ${b.ageNote}.`);
    }));

    // full numbers
    $("numbers").replaceChildren(
      el("thead", {}, el("tr", {}, ["Driver and car", "Top of picks", "Win", "Podium", "Pole", "Avg grid", "Avg finish", "Did not finish", "Pit stops", "Laps led"].map((x) => el("th", {}, x)))),
      el("tbody", {}, s.rows.map((r) => el("tr", {},
        el("td", { class: "who" }, el("span", { class: "swatch", style: `background:${color[r.key]}` }), r.name, el("span", {}, r.car)),
        el("td", {}, pct(r.beatsAll, 1)), el("td", {}, pct(r.win, 1)), el("td", {}, pct(r.podium, 1)), el("td", {}, pct(r.pole, 1)),
        el("td", {}, r.avgGrid.toFixed(1)), el("td", {}, r.avgPos.toFixed(1)), el("td", {}, pct(r.dnf, 1)),
        el("td", {}, r.avgStops.toFixed(1)), el("td", {}, r.lapsLed.toFixed(1))))));

    renderSample(s, color);
  }

  // a fresh single race with the same line-up, for the replay
  function anotherRace() {
    if (!lastSummary || !lastRun) return;
    const seed = Math.floor(Math.random() * 1e9);
    const show = (race) => {
      const s2 = Object.assign({}, lastSummary, { sample: race.sample });
      lastSummary = s2;
      const color = Object.fromEntries(s2.inputOrder.map((u) => [u.key, u.color]));
      renderSample(s2, color);
    };
    if (worker) {
      const id = ++runId;
      const prev = worker.onmessage;
      worker.onmessage = (ev) => {
        if (ev.data.id !== id) return prev && prev(ev);
        if (ev.data.type === "race") show(ev.data.race);
      };
      worker.postMessage({ id, kind: "race", seed, picks: lastRun.picks, track: lastRun.track, options: lastRun.options });
    } else {
      const bds = lastRun.picks.map((p) => M.entry(p.driver, p.car, p.peak));
      show(F1Sim.sampleRace(M, bds, lastRun.track, lastRun.options, seed));
    }
  }

  function renderSample(s, color) {
    const smp = s.sample, t = s.track, L = t.laps;
    const words = { dry: "a dry race", wet: "a wet start", mixed: "rain arriving mid-race" };
    $("sample-title").textContent = `Watch one of those races (${words[smp.weather]})`;
    if (!replay) replay = new Replay.ReplayView($("replay"), { onAnother: anotherRace, onLap: (lap) => lapCursor && lapCursor(lap) });
    replay.load(smp, s.entryInfo, t, circuits[s.trackRef], color);
    const users = s.inputOrder;
    const series = users.map((u) => ({ key: u.key, name: u.name, color: color[u.key], pts: smp.positions[u.key] }));
    let maxPos = 5;
    series.forEach((se) => se.pts.forEach((p) => { if (p && p > maxPos) maxPos = p; }));
    const W = 1000, H = 320, ml = 34, mr = 14, mt = 12, mb = 30;
    const x = (lap) => ml + ((lap - 1) / Math.max(1, L - 1)) * (W - ml - mr);
    const y = (p) => mt + ((p - 1) / Math.max(1, maxPos - 1)) * (H - mt - mb);
    const ns = "http://www.w3.org/2000/svg";
    const S = (tag, attrs, ...kids) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
      kids.forEach((c) => c && n.append(c));
      return n;
    };
    const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `Lap chart of one simulated race. Final result: ${series.map((se) => `${se.name} P${smp.cars[se.key].position}`).join(", ")}.` });
    // wet track shading
    const wetLaps = (smp.wetness || []).map((w, i) => (i >= 1 && w > 0.2 ? i : null)).filter((v) => v !== null);
    ranges(wetLaps).forEach(([a, b]) => svg.append(S("rect", { x: x(a), y: mt, width: Math.max(2, x(b) - x(a)), height: H - mt - mb, fill: "#2a78d6", opacity: 0.12 })));
    // safety car bands
    let scStart = null;
    for (const [lap, text] of smp.events) {
      if (/^Safety car (deployed|:)/.test(text) || text.startsWith("The race starts behind")) scStart = scStart ?? lap;
      if (text.startsWith("Safety car in") && scStart !== null) {
        svg.append(S("rect", { x: x(scStart), y: mt, width: Math.max(3, x(lap) - x(scStart)), height: H - mt - mb, fill: "#898781", opacity: 0.22 }));
        scStart = null;
      }
    }
    // grid lines + axes
    const step = maxPos > 12 ? 4 : maxPos > 6 ? 2 : 1;
    for (let p = 1; p <= maxPos; p += step) {
      svg.append(S("line", { x1: ml, x2: W - mr, y1: y(p), y2: y(p), stroke: "currentColor", "stroke-opacity": 0.12 }));
      const tx = S("text", { x: ml - 8, y: y(p) + 4, "text-anchor": "end", "font-size": 12, fill: "currentColor", opacity: 0.6 });
      tx.textContent = `P${p}`; svg.append(tx);
    }
    const lapStep = L > 60 ? 10 : 5;
    for (let lap = lapStep; lap <= L; lap += lapStep) {
      const tx = S("text", { x: x(lap), y: H - 8, "text-anchor": "middle", "font-size": 12, fill: "currentColor", opacity: 0.6 });
      tx.textContent = lap === lapStep ? `Lap ${lap}` : String(lap); svg.append(tx);
    }
    // lines
    for (const se of series) {
      let d = "", last = null;
      se.pts.forEach((p, i) => {
        if (p === null) return;
        const lap = i + 1;
        d += last === null ? `M${x(lap)},${y(p)}` : `H${x(lap)}V${y(p)}`;
        last = [lap, p];
      });
      svg.append(S("path", { d, fill: "none", stroke: se.color, "stroke-width": 2.5, "stroke-linejoin": "round" }));
      const c = smp.cars[se.key];
      if (last && !c.finished) {
        const [lx, ly] = [x(last[0]), y(last[1])];
        svg.append(S("path", { d: `M${lx - 5},${ly - 5}L${lx + 5},${ly + 5}M${lx + 5},${ly - 5}L${lx - 5},${ly + 5}`, stroke: se.color, "stroke-width": 2.5 }));
      }
    }
    // hover layer
    const cross = S("line", { y1: mt, y2: H - mb, stroke: "currentColor", "stroke-opacity": 0.4, visibility: "hidden" });
    const overlay = S("rect", { x: ml, y: mt, width: W - ml - mr, height: H - mt - mb, fill: "transparent" });
    svg.append(cross, overlay);
    const box = $("lapchart");
    const tip = el("div", { class: "tip", hidden: true });
    const legend = el("div", { class: "legend", style: "margin:0 0 8px" },
      series.map((se) => el("span", {}, el("i", { style: `background:${se.color}` }), se.name)));
    box.replaceChildren(legend, svg, tip);
    // follows the replay
    const marker = S("line", { y1: mt, y2: H - mb, stroke: "currentColor", "stroke-opacity": 0.55, "stroke-dasharray": "4 4" });
    svg.insertBefore(marker, cross);
    lapCursor = (lap) => { marker.setAttribute("x1", x(lap)); marker.setAttribute("x2", x(lap)); };
    lapCursor(1);
    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * W;
      const lap = Math.min(L, Math.max(1, Math.round(1 + ((vx - ml) / (W - ml - mr)) * (L - 1))));
      cross.setAttribute("x1", x(lap)); cross.setAttribute("x2", x(lap)); cross.setAttribute("visibility", "visible");
      const rows = series.map((se) => [se, se.pts[lap - 1]]).sort((a, b) => (a[1] ?? 99) - (b[1] ?? 99));
      tip.replaceChildren(el("div", { style: "font-weight:600;margin-bottom:2px" }, `Lap ${lap}`),
        ...rows.map(([se, p]) => el("div", {}, el("i", { style: `background:${se.color}` }), `${p ? "P" + p : "Out"}  ${se.name}`)));
      tip.hidden = false;
      const px = ((x(lap) / W) * rect.width) + 12;
      tip.style.left = `${Math.min(px + 12, rect.width - tip.offsetWidth)}px`;
      tip.style.top = "36px";
    };
    overlay.addEventListener("mousemove", (e) => move(e.clientX));
    overlay.addEventListener("touchmove", (e) => { move(e.touches[0].clientX); }, { passive: true });
    overlay.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });

    // result line + log
    const fin = series.slice().sort((a, b) => smp.cars[a.key].position - smp.cars[b.key].position);
    $("sample-result").replaceChildren(...fin.map((se, i) => {
      const c = smp.cars[se.key];
      const txt = c.finished ? `P${c.position} ${se.name} (from P${c.grid})` : `${se.name} retired on lap ${c.dnfLap} (${c.dnfReason.toLowerCase()})`;
      return el("span", {}, i ? "; " : "", c.finished && c.position === 1 ? el("strong", {}, txt) : txt);
    }));
    $("log").replaceChildren(...smp.events.map(([lap, text]) => el("li", {}, el("b", {}, lap === 0 ? "Quali" : `Lap ${lap}`), text)));
  }
  function ranges(laps) {
    const out = [];
    for (const l of laps) {
      if (out.length && l === out[out.length - 1][1] + 1) out[out.length - 1][1] = l;
      else out.push([l, l]);
    }
    return out;
  }

  init();
})();
