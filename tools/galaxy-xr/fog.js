(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 90) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 8000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  let calls = 0,
    renders = 0;
  const R = r.render;
  r.render = function (a, b) {
    R.call(this, a, b);
    renders++;
    calls = r.info.render.calls;
  };
  const out = { base: await measure(), baseCalls: calls };
  out.baseRenders = renders;
  renders = 0;
  // Same shaders, but the fog branch picks near/far so no pixel is fogged: tests the cost of *shading*, not a missing uniform.
  const mats = new Set();
  o.scene.traverse((x) => {
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) mats.add(m);
  });
  const was = [...mats].map((m) => [m, m.fog]);
  for (const [m] of was) {
    if ('fog' in m) {
      m.fog = false;
      m.needsUpdate = true;
    }
  }
  await wait(4000);
  out.noFog = await measure();
  out.noFogCalls = calls;
  out.noFogRenders = renders;
  renders = 0;
  for (const [m, f] of was) {
    if ('fog' in m) {
      m.fog = f;
      m.needsUpdate = true;
    }
  }
  await wait(4000);
  out.back = await measure();
  out.backCalls = calls;
  r.render = R;
  return out;
})();
