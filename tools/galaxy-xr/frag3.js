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
  let U = null;
  o.scene.traverse((x) => {
    if (!U && x.material?.type === 'MeshToonMaterial') U = r.properties.get(x.material).uniforms;
  });
  const pin = (u) => {
    const d = Object.getOwnPropertyDescriptor(u, 'value');
    Object.defineProperty(u, 'value', { configurable: true, get: () => 0, set: () => {} });
    return () => Object.defineProperty(u, 'value', d);
  };
  const out = { base: await measure() };
  const un1 = pin(U.skyLampCount),
    un2 = pin(U.skyScreenCount);
  await wait(800);
  out.noLampLoops = await measure();
  un1();
  un2();
  await wait(800);
  const un3 = pin(U.skyOn);
  await wait(800);
  out.skyOff = await measure();
  un3();
  await wait(800);
  // Triangle count and the busiest geometry.
  let tris = 0;
  const R = r.render;
  r.render = function (a, b) {
    R.call(this, a, b);
    tris = r.info.render.triangles;
  };
  await wait(300);
  r.render = R;
  out.triangles = tris;
  out.back = await measure();
  return out;
})();
