// Re-enter VR at a forced framebuffer scale and measure. Usage: set window.__scaleTry before running.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const scale = window.__scaleTry ?? 0.8;
  const orig = r.xr.setFramebufferScaleFactor;
  if (o.vr.active) await r.xr.getSession().end();
  for (let i = 0; i < 30 && (o.vr.active || r.xr.getSession()); i++) await new Promise((d) => setTimeout(d, 200));
  await new Promise((d) => setTimeout(d, 1500));
  r.xr.setFramebufferScaleFactor = function () {
    return orig.call(this, scale);
  };
  for (let i = 0; i < 4 && !o.vr.active; i++) {
    await o.vr.enter();
    if (!o.vr.active) await new Promise((d) => setTimeout(d, 2000));
  }
  r.xr.setFramebufferScaleFactor = orig;
  if (!o.vr.active) return { scale, fps: 'enter failed' };
  await new Promise((d) => setTimeout(d, 4000));
  o.vr.ui?.controls?.hide?.();
  await new Promise((d) => setTimeout(d, 4000));
  const s = r.xr.getSession();
  const t = [];
  let l = 0;
  await new Promise((d) => {
    const f = (x) => {
      if (l) t.push(x - l);
      l = x;
      t.length < 90 ? s.requestAnimationFrame(f) : d();
    };
    s.requestAnimationFrame(f);
    setTimeout(d, 8000);
  });
  const base = r.xr.getBaseLayer();
  return { scale, fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1), size: `${base.textureWidth ?? base.framebufferWidth}x${base.textureHeight ?? base.framebufferHeight}` };
})();
