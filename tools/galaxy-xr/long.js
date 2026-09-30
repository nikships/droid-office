// Per frame: interval since the last frame, and time spent in the callback split into render,
// vr.update and the rest. Shows whether the long (two-vsync) frames are long in JS.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const R = r.render;
  const U = o.vr.update;
  let rT = 0,
    uT = 0;
  r.render = function (a, b) {
    const t = performance.now();
    R.call(this, a, b);
    rT += performance.now() - t;
  };
  o.vr.update = function (...a) {
    const t = performance.now();
    const x = U.apply(this, a);
    uT += performance.now() - t;
    return x;
  };
  const orig = s.requestAnimationFrame.bind(s);
  const rows = [];
  let last = 0;
  s.requestAnimationFrame = (cb) =>
    orig((t, f) => {
      const t0 = performance.now();
      rT = 0;
      uT = 0;
      cb(t, f);
      const cbMs = performance.now() - t0;
      rows.push({ gap: last ? t - last : 0, cb: cbMs, render: rT, upd: uT, late: t0 - t });
      last = t;
    });
  await new Promise((d) => setTimeout(d, 6000));
  s.requestAnimationFrame = orig;
  r.render = R;
  o.vr.update = U;
  const f = rows.slice(2);
  const long = f.filter((x) => x.gap > 20);
  const short = f.filter((x) => x.gap <= 20);
  const avg = (a, k) => +(a.reduce((s, x) => s + x[k], 0) / Math.max(1, a.length)).toFixed(2);
  const max = (a, k) => +Math.max(0, ...a.map((x) => x[k])).toFixed(2);
  // Which frame precedes each long gap (the gap is measured on the frame after the slow one).
  const before = [];
  for (let i = 1; i < f.length; i++) if (f[i].gap > 20) before.push(f[i - 1]);
  const hist = {};
  for (const x of f) {
    const k = Math.round(x.gap / 13.9);
    hist[k] = (hist[k] ?? 0) + 1;
  }
  return {
    frames: f.length,
    longFrames: long.length,
    hist,
    short: { cb: avg(short, 'cb'), render: avg(short, 'render'), upd: avg(short, 'upd'), cbMax: max(short, 'cb') },
    frameBeforeLong: { cb: avg(before, 'cb'), render: avg(before, 'render'), upd: avg(before, 'upd'), cbMax: max(before, 'cb'), late: avg(before, 'late') },
    longSelf: { cb: avg(long, 'cb'), late: avg(long, 'late') },
    sampleBefore: before.slice(0, 8).map((x) => [x.cb, x.render, x.upd].map((v) => +v.toFixed(1)).join('/')),
  };
})();
