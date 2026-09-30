(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const _fps = (n = 90) =>
    new Promise((done) => {
      const times = [];
      let last = 0;
      const step = (t) => {
        if (last) times.push(t - last);
        last = t;
        if (times.length < n) s.requestAnimationFrame(step);
        else done();
      };
      s.requestAnimationFrame(step);
      setTimeout(done, 5000);
    }).then(() => 0) && measure(n);
  async function measure(n) {
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
      setTimeout(done, 6000);
    });
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { fps: +(1000 / avg).toFixed(1), p50ms: +times[times.length >> 1].toFixed(1) };
  }
  const settle = () => new Promise((d) => setTimeout(d, 600));
  const out = {};
  out.baseline = await measure(90);

  // 1. Nothing drawn: the ceiling of the pipeline itself (compositor, three's XR overhead, our frame()).
  const vis = o.scene.children.map((c) => c.visible);
  o.scene.children.forEach((c) => (c.visible = false));
  await settle();
  out.emptyScene = await measure(90);
  o.scene.children.forEach((c, i) => (c.visible = vis[i]));
  await settle();

  // 2. frame() without renderer.render: JS logic alone.
  const origRender = r.render;
  r.render = () => {};
  await settle();
  out.noRender = await measure(90);
  r.render = origRender;
  await settle();

  // 3. Shadows off entirely.
  const sm = r.shadowMap.enabled;
  r.shadowMap.enabled = false;
  await settle();
  out.noShadows = await measure(90);
  r.shadowMap.enabled = sm;
  await settle();

  // 4. vr.update skipped (picking, rays, panels).
  const vu = o.vr.update;
  o.vr.update = () => {};
  await settle();
  out.noVrUpdate = await measure(90);
  o.vr.update = vu;
  await settle();

  out.baselineAgain = await measure(90);
  return out;
})();
