(async () => {
  const o = window.__office;
  const r = o.renderer;
  const xr = r.xr;
  const scales = window.__sweepScales || [1.0, 1.2, 1.4];
  const orig = xr.__origSetScale || xr.setFramebufferScaleFactor;
  xr.__origSetScale = orig;
  const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
  async function measure(s, n = 60) {
    const times = [];
    let last = 0;
    await new Promise((done) => {
      const step = (t) => {
        if (last) times.push(t - last);
        last = t;
        if (times.length < n) s.requestAnimationFrame(step);
        else done();
      };
      s.requestAnimationFrame(step);
      setTimeout(done, 7000);
    });
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { fps: +(1000 / avg).toFixed(1), p50ms: +times[times.length >> 1].toFixed(1) };
  }
  const out = [];
  for (const sc of scales) {
    xr.setFramebufferScaleFactor = function (v) {
      return orig.call(this, v === 1 ? 1 : sc);
    };
    if (o.vr.active) {
      await o.vr.toggle();
      await sleep(1500);
    }
    await o.vr.enter();
    await sleep(2500);
    const s = xr.getSession();
    if (!s) {
      out.push({ scale: sc, error: 'no session' });
      continue;
    }
    const l = s.renderState.layers?.[0];
    const row = { scale: sc, tex: l ? [l.textureWidth, l.textureHeight] : null };
    row.full = await measure(s);
    const vis = o.scene.children.map((c) => c.visible);
    o.scene.children.forEach((c) => (c.visible = false));
    await sleep(500);
    row.empty = await measure(s);
    o.scene.children.forEach((c, i) => (c.visible = vis[i]));
    out.push(row);
  }
  xr.setFramebufferScaleFactor = orig;
  return out;
})();
