/* Animated race replay: cars on the real circuit layout, a live timing tower, flags, rain and
 * race control messages, with play/pause, speed controls and a lap scrubber. */
(function (root) {
  "use strict";
  const TYRE = { S: ["#e1261c", "Soft"], M: ["#f2c200", "Medium"], H: ["#ececec", "Hard"], I: ["#2bb673", "Intermediate"], W: ["#2a78d6", "Full wet"] };
  const SPEEDS = [1, 5, 10, 25, 50, 100];
  const START = -5;          // the five start lights come on during the last five seconds
  const CAMERAS = [["tcam", "T-cam"], ["cockpit", "Cockpit"], ["chase", "Chase"], ["tv", "TV"]];
  const webgl = (() => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } })();
  const FIELD_COLOR = "#8b939e";
  const NS = "http://www.w3.org/2000/svg";
  const reduceMotion = () => root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined) n.append(c);
    return n;
  };
  const s = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };
  const hash = (str) => { let x = 2166136261; for (const ch of str) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return ((x >>> 0) % 10000) / 10000; };
  const clock = (t) => { const m = Math.floor(t / 60), sec = Math.floor(t % 60); return `${m}:${String(sec).padStart(2, "0")}`; };

  // ---------------------------------------------------------------- track geometry
  function genericLoop() {
    const pts = [], n = 400, w = 1000, hgt = 520, r = 200;
    const per = 2 * (w - 2 * r) + 2 * (hgt - 2 * r) + 2 * Math.PI * r;
    for (let i = 0; i < n; i++) {
      let d = (per * i) / n;
      const seg = [w - 2 * r, Math.PI * r / 2, hgt - 2 * r, Math.PI * r / 2, w - 2 * r, Math.PI * r / 2, hgt - 2 * r, Math.PI * r / 2];
      let k = 0; while (d > seg[k]) { d -= seg[k]; k = (k + 1) % 8; }
      const corners = [[w - r, r], [w - r, hgt - r], [r, hgt - r], [r, r]];
      let p;
      if (k === 0) p = [r + d, 0]; else if (k === 2) p = [w, r + d]; else if (k === 4) p = [w - r - d, hgt]; else if (k === 6) p = [0, hgt - r - d];
      else { const c = corners[(k - 1) / 2], a = -Math.PI / 2 + ((k - 1) / 2) * (Math.PI / 2) + d / r; p = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }
      pts.push(p);
    }
    return { w, h: hgt, points: pts, generic: true };
  }

  // time-fraction -> distance-fraction lookup: cars slow down in corners and speed up on straights
  function buildGeometry(circuit) {
    const P = circuit.points, n = P.length;
    const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
    const kappa = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = P[(i - 3 + n) % n], b = P[i], c = P[(i + 3) % n];
      let d = ang(b, c) - ang(a, b);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      kappa[i] = Math.abs(d);
    }
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = -2; j <= 2; j++) m = Math.max(m, kappa[(i + j + n) % n]);
      v[i] = Math.max(0.42, 1 / (1 + 2.4 * m));
    }
    const vs = new Float64Array(n);  // smooth to mimic braking and acceleration zones
    for (let i = 0; i < n; i++) { let t = 0; for (let j = -6; j <= 6; j++) t += v[(i + j + n) % n]; vs[i] = t / 13; }
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + 1 / vs[i];
    const total = cum[n];
    const LUT = 1024, lut = new Float64Array(LUT + 1);
    let j = 0;
    for (let k = 0; k <= LUT; k++) {
      const target = (k / LUT) * total;
      while (j < n - 1 && cum[j + 1] < target) j++;
      const f = (target - cum[j]) / (cum[j + 1] - cum[j] || 1);
      lut[k] = (j + Math.min(1, Math.max(0, f))) / n;
    }
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    return {
      points: P, generic: !!circuit.generic,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)],
      timeToDist(phi) { const x = Math.min(1, Math.max(0, phi)) * LUT, k = Math.floor(x), f = x - k; return k >= LUT ? lut[LUT] : lut[k] + (lut[k + 1] - lut[k]) * f; },
      at(frac) {
        let f = frac - Math.floor(frac);
        const x = f * n, k = Math.floor(x) % n, t = x - Math.floor(x), a = P[k], b = P[(k + 1) % n];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      },
    };
  }

  // ---------------------------------------------------------------- the view
  class ReplayView {
    constructor(container, options) {
      this.root = container;
      this.opts = options || {};
      this.speed = 25;
      this.playing = false;
      this.T = START;
      this.view = "map";
      this.watch = null;
      this.camMode = "tcam";
      this.raf = null;
      this.lastTowerUpdate = 0;
      this.lastLap = 0;
      this.autoplay = false;
      // start playing the first time the replay scrolls into view
      if ("IntersectionObserver" in root) {
        this.io = new IntersectionObserver((ents) => {
          if (ents.some((e) => e.isIntersecting) && this.autoplay) { this.autoplay = false; this.play(); }
        }, { threshold: 0.35 });
        this.io.observe(container);
      }
    }

    load(race, entryInfo, track, circuit, colorOf) {
      this.stop();
      this.race = race;
      this.info = entryInfo;
      this.track = track;
      this.colorOf = colorOf;
      this.L = race.laps;
      this.geo = buildGeometry(circuit || genericLoop());
      this.circuit3d = circuit ? Object.assign({}, circuit) : null;
      const tr = race.trace;
      const keys = Object.keys(tr.cars);
      this.cars = keys.map((k) => {
        const c = tr.cars[k], res = race.cars[k];
        const e = c.lapEnd, nl = e.length;
        const lapT = nl > 1 ? e[nl - 1] - e[nl - 2] : (nl ? e[0] : this.track.base_lap);
        const firstLapT = this.track.base_lap * 1.06 + 2.5;
        return {
          key: k, info: entryInfo[k], color: colorOf[k] || FIELD_COLOR, user: !!colorOf[k], res, lapT: nl ? lapT : firstLapT,
          start: c.start, lapEnd: e, tyres: c.tyres, pits: new Set(c.pits),
          gridBack: (res.grid - 1) * 0.004,
          retireT: res.finished ? null : (nl ? e[nl - 1] : 0) + (nl ? lapT : firstLapT) * (0.2 + 0.7 * hash(k + race.laps)),
          retireD: res.finished ? null : nl + (0.2 + 0.7 * hash(k + race.laps)) * 0.999,
        };
      });
      let ui = 0;
      for (const c of this.cars) if (c.user) c.side = ui++ % 2 ? 1 : -1;
      const finishes = this.cars.filter((c) => c.res.finished).map((c) => c.lapEnd[c.lapEnd.length - 1]);
      this.winnerT = Math.min(...finishes);
      this.endT = Math.max(...finishes, ...this.cars.map((c) => c.retireT || 0)) + 4;
      this.render();
      if (!this.watch || !this.cars.some((c) => c.key === this.watch)) this.watch = Object.keys(colorOf)[0] || this.cars[0].key;
      this.seekTime(START);
      if (this.view === "onboard") this.loadOnboard();
      this.autoplay = !reduceMotion();
      if (this.autoplay && this.io) {             // already on screen (e.g. "Watch a different race")
        const r = this.root.getBoundingClientRect();
        if (r.top < innerHeight * 0.65 && r.bottom > innerHeight * 0.35) { this.autoplay = false; this.play(); }
      } else if (this.autoplay) { this.autoplay = false; this.play(); }
    }

    // distance (in laps) and state of a car at race time T
    stateAt(c, T) {
      const e = c.lapEnd, n = e.length;
      if (c.retireT !== null && T >= c.retireT) return { d: c.retireD, out: true, outAt: c.retireT };
      if (T <= 0) return { d: -c.gridBack, lap: 1, tyre: c.tyres[0] };
      if (n === 0) {                                     // retires on the opening lap
        const frac = this.geo.timeToDist(T / c.lapT);
        return { d: -c.gridBack + (1 + c.gridBack) * frac, lap: 1, lapTime: c.lapT, tyre: c.tyres[0] };
      }
      if (n && T >= e[n - 1]) {
        if (c.res.finished) return { d: this.L, done: true, doneAt: e[n - 1] };
        // between its last completed lap and retirement
        return { d: Math.min(c.retireD, n + (T - e[n - 1]) / c.lapT), lap: n + 1, lapTime: c.lapT, tyre: c.tyres[n] };
      }
      let k = 0; while (k < n && e[k] < T) k++;           // T falls in lap k+1
      const a = k === 0 ? 0 : e[k - 1], b = e[k];
      const frac = this.geo.timeToDist((T - a) / (b - a));
      const d = k === 0 ? -c.gridBack + (1 + c.gridBack) * frac : k + frac;
      return { d, lap: k + 1, lapTime: b - a, pit: c.pits.has(k + 1), tyre: c.tyres[k] };
    }

    render() {
      const g = this.geo, [bx, by, bw, bh] = g.box, pad = 60;
      this.svg = s("svg", { viewBox: `${bx - pad} ${by - pad} ${bw + 2 * pad} ${bh + 2 * pad}`, class: "replay-map", role: "img",
        "aria-label": `Animated replay of one simulated race at ${this.track.name}` });
      const d = "M" + g.points.map((p) => p.join(",")).join("L") + "Z";
      this.svg.append(s("path", { d, class: "track-edge" }), s("path", { d, class: "track-surface" }));
      this.wetLayer = s("path", { d, class: "track-wet" });
      this.svg.append(this.wetLayer);
      // start/finish line, perpendicular to the track
      const p0 = g.points[0], p1 = g.points[2];
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + Math.PI / 2, L = 22;
      this.svg.append(s("line", { x1: p0[0] - L * Math.cos(ang), y1: p0[1] - L * Math.sin(ang), x2: p0[0] + L * Math.cos(ang), y2: p0[1] + L * Math.sin(ang), class: "finish-line" }));
      this.dots = {};
      const order = this.cars.slice().sort((a, b) => a.user - b.user);
      for (const c of order) {
        const grp = s("g", { class: c.user ? "car user" : "car" });
        grp.addEventListener("click", () => this.watchCar(c.key));
        grp.style.cursor = "pointer";
        const title = s("title"); title.textContent = `${c.info.name}: watch onboard`; grp.append(title);
        grp.append(s("circle", { r: c.user ? 15 : 10, fill: c.color }));
        if (c.user) {
          const t = s("text", { x: 0, y: 0, class: "car-label", "text-anchor": "middle" });
          t.textContent = c.info.short || c.info.name.slice(0, 3).toUpperCase();
          grp.append(t);
          c.label = t;
        }
        this.svg.append(grp);
        this.dots[c.key] = grp;
      }

      // controls
      this.playBtn = h("button", { type: "button", class: "rp-play", onclick: () => (this.playing ? this.pause() : this.play()) }, "Pause");
      this.speedBtns = SPEEDS.map((sp) => h("button", { type: "button", class: "rp-speed", "aria-pressed": String(sp === this.speed),
        onclick: () => this.setSpeed(sp) }, `${sp}×`));
      this.slider = h("input", { type: "range", min: 0, max: this.L, step: 1, value: 0, class: "rp-slider", "aria-label": "Jump to lap" });
      this.slider.addEventListener("input", () => this.seekLap(+this.slider.value));
      this.lapLabel = h("span", { class: "rp-lap" });
      this.clockLabel = h("span", { class: "rp-clock" });
      this.flag = h("span", { class: "rp-flag" });
      this.wetFlag = h("span", { class: "rp-flag rp-rain", hidden: true }, "Wet track");
      this.ticker = h("ol", { class: "rp-ticker", "aria-live": "off" });
      this.tower = h("ol", { class: "rp-tower", style: `height:${this.cars.length * 30}px` });
      this.rows = {};
      for (const c of this.cars) {
        const row = h("li", { class: c.user ? "user" : "", tabindex: 0, role: "button", title: `Watch ${c.info.name} onboard`,
          onclick: () => this.watchCar(c.key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.watchCar(c.key); } } },
          h("span", { class: "rp-pos" }), h("i", { class: "rp-chip", style: `background:${c.color}` }),
          h("span", { class: "rp-name", text: c.user || c.info.car ? c.info.name.split(" ").slice(-1)[0] : c.info.name.replace("Field car", "Field") }),
          h("span", { class: "rp-gap" }), h("i", { class: "rp-tyre" }));
        this.tower.append(row);
        this.rows[c.key] = row;
      }
      const note = this.geo.generic ? h("p", { class: "rp-note" }, "We don't have this circuit's layout, so the replay uses a generic loop.") : null;
      this.viewBtns = [["map", "Track map"], ["onboard", "Onboard"]].map(([v, label]) => h("button", { type: "button", class: "rp-view",
        "aria-pressed": String(this.view === v), disabled: v === "onboard" && !webgl ? true : null,
        title: v === "onboard" && !webgl ? "Your browser can't show 3D graphics" : null, onclick: () => this.setView(v) }, label));
      this.obWrap = this.buildOnboardShell();
      this.svg.style.display = this.view === "map" ? "" : "none";
      this.root.replaceChildren(
        h("div", { class: "rp-status" }, this.lapLabel, this.clockLabel, this.flag, this.wetFlag,
          h("div", { class: "rp-views", role: "group", "aria-label": "Replay view" }, this.viewBtns)),
        h("div", { class: "rp-mapwrap" }, this.svg, this.obWrap, note),
        h("div", { class: "rp-side" }, this.tower),
        h("div", { class: "rp-controls" }, this.playBtn,
          h("div", { class: "rp-speeds", role: "group", "aria-label": "Replay speed" }, this.speedBtns),
          h("label", { class: "rp-scrub" }, h("span", { text: "Lap" }), this.slider),
          h("button", { type: "button", class: "rp-ghost", onclick: () => this.seekTime(this.endT) }, "Skip to the finish"),
          this.opts.onAnother ? h("button", { type: "button", class: "rp-ghost", onclick: this.opts.onAnother }, "Watch a different race") : null),
        this.ticker);
    }

    buildOnboardShell() {
      const wrap = h("div", { class: "ob-wrap", tabindex: 0, hidden: this.view !== "onboard" ? true : null,
        "aria-label": "Onboard camera. Left and right arrows change car, C changes camera." });
      wrap.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); this.cycleCar(e.key === "ArrowRight" ? 1 : -1); }
        if (e.key === "c" || e.key === "C") { const i = CAMERAS.findIndex(([m]) => m === this.camMode); this.setCam(CAMERAS[(i + 1) % CAMERAS.length][0]); }
        if (e.key === " ") { e.preventDefault(); this.playing ? this.pause() : this.play(); }
      });
      this.obStage = h("div", { class: "ob-stage" });
      this.obLoading = h("p", { class: "ob-loading" }, "Building the circuit…");
      const H = (cls) => h("span", { class: cls });
      this.hud = {
        pos: H("ob-pos"), stripe: h("i", { class: "ob-stripe" }), name: h("strong"), car: h("span"),
        speed: h("b"), gear: H("ob-gear"), rpm: h("i"), thr: h("i", { class: "thr" }), brk: h("i", { class: "brk" }),
        ahead: h("div"), behind: h("div"), tyre: h("div"),
      };
      const hd = this.hud;
      const hudEl = h("div", { class: "ob-hud", "aria-hidden": "true" },
        h("div", { class: "ob-id" }, hd.pos, hd.stripe, h("div", {}, hd.name, hd.car)),
        h("div", { class: "ob-speed" }, h("div", { class: "ob-kmh" }, hd.speed, h("span", {}, "km/h")), hd.gear,
          h("div", { class: "ob-rpm" }, hd.rpm), h("div", { class: "ob-pedals" }, hd.thr, hd.brk)),
        h("div", { class: "ob-gaps" }, hd.ahead, hd.behind, hd.tyre));
      this.obSelect = h("select", { class: "ob-select", "aria-label": "Car to watch", onchange: (e) => this.watchCar(e.target.value) });
      this.camBtns = CAMERAS.map(([m, label]) => h("button", { type: "button", class: "rp-speed", "aria-pressed": String(m === this.camMode), onclick: () => this.setCam(m) }, label));
      const bar = h("div", { class: "ob-bar" },
        h("div", { class: "ob-pick" },
          h("button", { type: "button", class: "rp-ghost", "aria-label": "Previous car", onclick: () => this.cycleCar(-1) }, "‹"),
          this.obSelect,
          h("button", { type: "button", class: "rp-ghost", "aria-label": "Next car", onclick: () => this.cycleCar(1) }, "›")),
        h("div", { class: "rp-speeds", role: "group", "aria-label": "Camera" }, this.camBtns));
      wrap.append(h("div", { class: "ob-screen" }, this.obStage, hudEl, this.obLoading), bar);
      this.fillSelect();
      return wrap;
    }
    fillSelect() {
      if (!this.obSelect) return;
      const users = this.cars.filter((c) => c.user), field = this.cars.filter((c) => !c.user);
      const opt = (c) => h("option", { value: c.key }, c.info.car ? `${c.info.name} (${c.info.car})` : c.info.name);
      this.obSelect.replaceChildren(h("optgroup", { label: "Your drivers" }, users.map(opt)), h("optgroup", { label: "Rest of the grid" }, field.map(opt)));
      if (this.watch) this.obSelect.value = this.watch;
    }
    setView(v) {
      if (v === "onboard" && !webgl) return;
      this.view = v;
      this.viewBtns.forEach((b) => b.setAttribute("aria-pressed", String((b.textContent === "Onboard") === (v === "onboard"))));
      this.svg.style.display = v === "map" ? "" : "none";
      this.obWrap.hidden = v !== "onboard";
      if (v === "onboard") this.loadOnboard();
      this.draw(performance.now(), true);
    }
    async loadOnboard() {
      this.obLoading.hidden = false;
      this.obLoading.textContent = "Building the circuit…";
      try {
        if (!this.ob) {
          const mod = await import("./onboard.js");
          this.ob = new mod.OnboardView(this.obStage);
        }
        const circuit = this.circuit3d || genericLoop();
        if (!circuit.length_m) circuit.length_m = Math.round(this.track.base_lap * 58);
        await this.ob.load({ circuit, trackMeta: this.track, race: this.race, entries: this.info, colorOf: this.colorOf, laps: this.L });
        this.ob.setMode(this.camMode);
        this.ob.select(this.watch);
        this.obLoading.hidden = true;
        this.draw(performance.now(), true);
      } catch (err) {
        this.obLoading.textContent = `The onboard view couldn't start: ${err && err.message ? err.message : err}`;
      }
    }
    watchCar(key) {
      this.watch = key;
      if (this.obSelect) this.obSelect.value = key;
      Object.entries(this.rows || {}).forEach(([k, r]) => r.classList.toggle("watching", k === key && this.view === "onboard"));
      if (this.view !== "onboard") this.setView("onboard");
      if (this.ob) this.ob.select(key);
      this.draw(performance.now(), true);
    }
    cycleCar(dir) {
      const order = this.lastOrder || this.cars.map((c) => c.key);
      const i = order.indexOf(this.watch);
      this.watchCar(order[(i + dir + order.length) % order.length]);
    }
    setCam(m) {
      this.camMode = m;
      this.camBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(CAMERAS[i][0] === m)));
      if (this.ob) this.ob.setMode(m);
    }
    updateHud() {
      const d = this.ob && this.ob.hud();
      if (!d) return;
      const hd = this.hud, c = d.car;
      hd.pos.textContent = d.out ? "Out" : `P${d.position}`;
      hd.stripe.style.background = c.user ? c.livery : "#8b939e";
      hd.name.textContent = c.info.name;
      hd.car.textContent = c.info.car || "Field car";
      hd.speed.textContent = String(Math.round(d.kmh));
      hd.gear.textContent = d.kmh < 3 ? "N" : String(d.gear);
      hd.rpm.style.width = `${(d.rpm * 100).toFixed(0)}%`;
      hd.thr.style.height = `${(d.throttle * 100).toFixed(0)}%`;
      hd.brk.style.height = `${(d.brake * 100).toFixed(0)}%`;
      const fmt = (o, sign) => (o ? `${o.name} ${sign}${o.gap.toFixed(1)}s` : "–");
      hd.ahead.textContent = `Ahead: ${fmt(d.ahead, "+")}`;
      hd.behind.textContent = `Behind: ${fmt(d.behind, "−")}`;
      hd.tyre.replaceChildren(h("i", { class: "ob-tyre", style: `background:${d.tyreHex}` }), d.tyreName ? `${d.tyreName} tyres` : "");
    }

    setSpeed(sp) {
      this.speed = sp;
      this.speedBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(SPEEDS[i] === sp)));
    }
    play() {
      if (this.T >= this.endT) this.seekTime(START);
      this.playing = true; this.playBtn.textContent = "Pause";
      let last = performance.now();
      const tick = (now) => {
        if (!this.playing) return;
        const dt = Math.min(0.25, (now - last) / 1000); last = now;
        this.T = Math.min(this.endT, this.T + dt * this.speed);
        this.draw(now);
        if (this.T >= this.endT) { this.pause(); return; }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    pause() { this.playing = false; if (this.playBtn) this.playBtn.textContent = this.T >= this.endT ? "Replay" : "Play"; if (this.raf) cancelAnimationFrame(this.raf); }
    stop() { this.pause(); }
    seekTime(T) { this.T = Math.max(START, Math.min(this.endT, T)); this.lastTowerUpdate = 0; this.draw(performance.now(), true); if (!this.playing) this.pause(); }
    seekLap(lap) {
      const leader = this.cars.filter((c) => c.res.position === 1)[0];
      this.seekTime(lap <= 0 ? START : leader.lapEnd[Math.min(lap, leader.lapEnd.length) - 1] - 0.01);
    }

    draw(now, force) {
      const T = this.T, st = {};
      for (const c of this.cars) st[c.key] = this.stateAt(c, T);
      // cars on the map
      for (const c of this.cars) {
        const x = st[c.key], g = this.dots[c.key];
        const [px, py] = this.geo.at(x.d);
        g.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
        if (c.label) {     // label beside the track, alternating sides so neighbours don't collide
          const [qx, qy] = this.geo.at(x.d + 0.004);
          let nx = -(qy - py), ny = qx - px; const len = Math.hypot(nx, ny) || 1;
          nx = (nx / len) * 40 * c.side; ny = (ny / len) * 40 * c.side;
          c.label.setAttribute("x", nx.toFixed(1)); c.label.setAttribute("y", (ny + 9).toFixed(1));
        }
        const fade = x.out ? Math.max(0, 1 - (T - c.retireT) / 40) * 0.5 : x.done ? Math.max(0, 1 - (T - x.doneAt) / 25) : 1;
        g.style.opacity = fade.toFixed(2);
      }
      // leader, lap, flags
      const running = this.cars.filter((c) => !st[c.key].out);
      const leaderD = Math.max(...running.map((c) => st[c.key].d));
      const lap = Math.max(1, Math.min(this.L, Math.floor(leaderD) + 1));
      const finished = T >= this.winnerT;
      this.lapLabel.textContent = finished ? `Finished, ${this.L} laps` : T < 0 ? `Start lights: ${Math.min(5, Math.max(1, Math.floor(T + 6)))} of 5` : T < 2 ? "Lights out" : `Lap ${lap} of ${this.L}`;
      this.clockLabel.textContent = clock(Math.max(0, T));
      const neutral = this.race.trace.neutral[lap - 1];
      this.flag.textContent = finished ? "Chequered flag" : neutral === "SC" ? "Safety car" : neutral === "VSC" ? "Virtual safety car" : "Green flag";
      this.flag.dataset.state = finished ? "chequered" : neutral || "green";
      const wet = (this.race.wetness || [])[lap] || 0;
      this.wetFlag.hidden = wet < 0.2;
      this.wetLayer.style.opacity = String(Math.min(0.45, wet * 0.6));
      if (!this.slider.matches(":active")) this.slider.value = finished ? this.L : lap - 1;
      if (lap !== this.lastLap) { this.lastLap = lap; if (this.opts.onLap) this.opts.onLap(lap); }
      if (force || now - this.lastTowerUpdate > 180) { this.lastTowerUpdate = now; this.drawTower(st, T, leaderD, finished); this.drawTicker(lap, T); }
      if (this.view === "onboard" && this.ob && this.ob.ready) {
        this.ob.update(T, st, { lap, neutral: finished ? null : neutral, wet });
        this.updateHud();
      }
    }

    drawTower(st, T, leaderD, finished) {
      // finished cars by classification, then cars still running by distance, then retirements
      const rank = (x) => (x.out ? 2 : x.done ? 0 : 1);
      const order = this.cars.slice().sort((a, b) => {
        const A = st[a.key], B = st[b.key];
        if (rank(A) !== rank(B)) return rank(A) - rank(B);
        if (A.done) return a.res.position - b.res.position;
        return B.d - A.d;
      });
      const winnerTime = this.winnerT;
      this.lastOrder = order.map((c) => c.key);
      order.forEach((c, i) => {
        const row = this.rows[c.key], x = st[c.key];
        row.style.transform = `translateY(${i * 30}px)`;
        row.children[0].textContent = String(i + 1);
        let gap;
        if (x.out) gap = "Out";
        else if (x.done) gap = i === 0 ? "Winner" : (c.lapEnd.length < this.L ? `+${this.L - c.lapEnd.length} lap` : `+${(c.lapEnd[c.lapEnd.length - 1] - winnerTime).toFixed(1)}s`);
        else if (i === 0) gap = T <= 0 ? "Pole" : "Leader";
        else if (x.pit) gap = "In pits";
        else {
          const behind = leaderD - x.d;
          gap = behind >= 1 ? `+${Math.floor(behind)} lap${behind >= 2 ? "s" : ""}` : `+${(behind * (x.lapTime || this.track.base_lap)).toFixed(1)}`;
        }
        row.children[3].textContent = gap;
        const ty = x.tyre || c.tyres[Math.min(c.tyres.length - 1, Math.max(0, (x.lap || 1) - 1))];
        const t = TYRE[ty];
        row.children[4].style.background = t ? t[0] : "transparent";
        row.children[4].title = t ? `${t[1]} tyres` : "";
        row.classList.toggle("out", !!x.out);
        row.classList.toggle("watching", this.view === "onboard" && c.key === this.watch);
      });
    }

    drawTicker(lap, T) {
      const evs = this.race.events.filter(([l]) => l === 0 || (T > 0 && l <= lap));
      const recent = evs.slice(-4).reverse();
      const sig = recent.map((e) => e.join("|")).join("~");
      if (sig === this.lastTicker) return;
      this.lastTicker = sig;
      this.ticker.replaceChildren(...recent.map(([l, text]) => h("li", {}, h("b", {}, l === 0 ? "Quali" : `Lap ${l}`), text)));
    }
  }

  root.Replay = { ReplayView };
})(typeof window !== "undefined" ? window : this);
