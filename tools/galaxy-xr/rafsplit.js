// Time inside the XR frame callback vs outside it, over ~60 frames.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const inside = [];
  const R = r.render;
  const frameStart = 0;
  // The app's loop is the renderer's animation loop; wrap render + vr.update via the loop callback.
  const loop = r.xr._animationLoop ?? null;
  void loop;
  const U = o.vr.update;
  let u0 = 0,
    uSum = 0,
    rSum = 0,
    n = 0,
    pre = 0;
  o.vr.update = function (...a) {
    u0 = performance.now();
    const x = U.apply(this, a);
    uSum += performance.now() - u0;
    return x;
  };
  r.render = function (a, b) {
    const t0 = performance.now();
    R.call(this, a, b);
    rSum += performance.now() - t0;
    n++;
  };
  // Whole callback: session rAF runs three's onAnimationFrame which calls the app loop.
  const origRAF = s.requestAnimationFrame.bind(s);
  let cbSum = 0,
    cbN = 0;
  s.requestAnimationFrame = (cb) =>
    origRAF((t, f) => {
      const t0 = performance.now();
      cb(t, f);
      cbSum += performance.now() - t0;
      cbN++;
    });
  await new Promise((d) => setTimeout(d, 3000));
  s.requestAnimationFrame = origRAF;
  o.vr.update = U;
  r.render = R;
  void inside;
  void frameStart;
  void pre;
  return { frames: n, callbackMs: +(cbSum / cbN).toFixed(2), renderMs: +(rSum / n).toFixed(2), vrUpdateMs: +(uSum / n).toFixed(2), otherMs: +((cbSum - rSum - uSum) / cbN).toFixed(2) };
})();
