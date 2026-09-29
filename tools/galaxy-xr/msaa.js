// Re-enter VR with the context reporting antialias off (three then makes a 0-sample XR target), measure, then restore.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const measure = async () => {
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
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  };
  const reenter = async (aa) => {
    if (o.vr.active) {
      await r.xr.getSession().end();
    }
    for (let i = 0; i < 30 && (o.vr.active || r.xr.getSession()); i++) await new Promise((d) => setTimeout(d, 200));
    await new Promise((d) => setTimeout(d, 1000));
    const orig = gl.getContextAttributes.bind(gl);
    gl.getContextAttributes = () => ({ ...orig(), antialias: aa });
    for (let i = 0; i < 3 && !o.vr.active; i++) {
      await o.vr.enter();
      if (!o.vr.active) await new Promise((d) => setTimeout(d, 1500));
    }
    if (!o.vr.active) return 'enter failed';
    gl.getContextAttributes = orig;
    await new Promise((d) => setTimeout(d, 5000));
    o.vr.ui?.controls?.hide?.();
    await new Promise((d) => setTimeout(d, 1500));
    return measure();
  };
  const out = {};
  out.msaaOff = await reenter(false);
  out.msaaOn = await reenter(true);
  return out;
})();
