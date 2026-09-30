// Interleaved A/B: flips a toggle each window so drift (thermals, pose) hits both arms equally.
// window.__ab = { name: { on(), off() } ... }. Reports fps per arm, median of windows.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const measure = async (n = 40) => {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 4000);
    });
    return 1000 / (t.reduce((a, b) => a + b, 0) / t.length);
  };
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const med = (a) => {
    const b = [...a].sort((x, y) => x - y);
    return +b[b.length >> 1].toFixed(1);
  };
  const out = {};
  for (const [name, t] of Object.entries(window.__ab)) {
    const on = [],
      off = [];
    for (let i = 0; i < (window.__abRounds ?? 4); i++) {
      await t.off();
      await wait(t.settle ?? 400);
      off.push(await measure());
      await t.on();
      await wait(t.settle ?? 400);
      on.push(await measure());
    }
    await t.off();
    out[name] = { off: med(off), on: med(on) };
  }
  return out;
})();
