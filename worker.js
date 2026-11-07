/* Runs simulations off the main thread so the page stays responsive. */
importScripts("sim.js");

let model = null;
async function load() {
  if (model) return model;
  const [r, t] = await Promise.all([fetch("data/ratings.json"), fetch("data/tracks.json")]);
  model = new F1Sim.Model(await r.json(), await t.json());
  return model;
}

self.onmessage = async (ev) => {
  const { id, picks, track, options } = ev.data;
  try {
    const m = await load();
    const bds = picks.map((p) => m.entry(p.driver, p.car, p.peak));
    let last = 0;
    const summary = F1Sim.simulate(m, bds, track, options, (f) => {
      if (f - last >= 0.02 || f === 1) { last = f; self.postMessage({ id, type: "progress", value: f }); }
    });
    self.postMessage({ id, type: "done", summary });
  } catch (err) {
    self.postMessage({ id, type: "error", message: String(err && err.message ? err.message : err) });
  }
};
