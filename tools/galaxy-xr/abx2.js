// abx.js for toggles that restart the session: re-reads the session per window and reports the
// visibility of each window (a system overlay such as the keyboard makes a window worthless).
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const measure = async (n = 60) => {
    const s = r.xr.getSession();
    if (!s) return { fps: 0, vis: 'none' };
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 5000);
    });
    return { fps: 1000 / (t.reduce((a, b) => a + b, 0) / t.length), vis: s.visibilityState };
  };
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const med = (a) => {
    const b = [...a].sort((x, y) => x - y);
    return +b[b.length >> 1].toFixed(1);
  };
  const out = {};
  for (const [name, t] of Object.entries(window.__ab)) {
    const on = [],
      off = [],
      bad = [];
    for (let i = 0; i < (window.__abRounds ?? 3); i++) {
      await t.off();
      await wait(t.settle ?? 400);
      let m = await measure();
      (m.vis === 'visible' ? off : bad).push(`off:${m.fps.toFixed(1)}:${m.vis}`);
      if (m.vis === 'visible') off[off.length - 1] = m.fps;
      await t.on();
      await wait(t.settle ?? 400);
      m = await measure();
      (m.vis === 'visible' ? on : bad).push(`on:${m.fps.toFixed(1)}:${m.vis}`);
      if (m.vis === 'visible') on[on.length - 1] = m.fps;
    }
    out[name] = { off: off.length ? med(off) : null, on: on.length ? med(on) : null, n: [off.length, on.length], bad };
  }
  return out;
})();
