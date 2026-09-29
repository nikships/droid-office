(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 60) {
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
  const settle = () => new Promise((d) => setTimeout(d, 700));
  const out = {};
  const R = r.render;
  let rt = 0,
    rn = 0;
  r.render = function (a, b) {
    const t0 = performance.now();
    R.call(this, a, b);
    rt += performance.now() - t0;
    rn++;
  };
  out.baseline = await measure();
  out.baseline.renderCpuMs = +(rt / rn).toFixed(1);
  r.render = R;

  // Fragment cost: same draw calls, cheapest shader.
  let MeshBasic;
  o.scene.traverse((x) => {
    if (!MeshBasic && x.material?.type === 'MeshBasicMaterial') MeshBasic = x.material.constructor;
  });
  o.scene.overrideMaterial = new MeshBasic({ color: 0x808080 });
  await settle();
  out.basicMaterial = await measure();
  o.scene.overrideMaterial = null;
  await settle();

  // Empty scene: the floor for this resolution.
  const vis = o.scene.children.map((c) => c.visible);
  o.scene.children.forEach((c) => (c.visible = false));
  await settle();
  out.emptyScene = await measure();
  o.scene.children.forEach((c, i) => (c.visible = vis[i]));
  await settle();

  // Shadows fully off.
  r.shadowMap.enabled = false;
  o.scene.traverse((x) => {
    if (x.material && !Array.isArray(x.material)) x.material.needsUpdate = true;
  });
  await settle();
  out.noShadowMap = await measure();
  r.shadowMap.enabled = true;
  o.scene.traverse((x) => {
    if (x.material && !Array.isArray(x.material)) x.material.needsUpdate = true;
  });
  r.shadowMap.needsUpdate = true;
  await settle();
  out.baselineAgain = await measure();
  return out;
})();
