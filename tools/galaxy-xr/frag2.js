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
  const allMats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const base = r.xr.getBaseLayer();
  const out = { base: await measure(), fov0: base.fixedFoveation, shadowType: r.shadowMap.type };
  let sun;
  o.scene.traverse((x) => {
    if (x.isDirectionalLight) sun = x;
  });
  out.shadowMapSize = sun?.shadow.mapSize.toArray();
  for (const f of [0.5, 1]) {
    base.fixedFoveation = f;
    await wait(800);
    out[`fov${f}`] = await measure();
    out[`fov${f}read`] = base.fixedFoveation;
  }
  base.fixedFoveation = out.fov0;
  await wait(800);
  r.shadowMap.type = 0; // BasicShadowMap
  for (const m of allMats()) m.needsUpdate = true;
  r.shadowMap.needsUpdate = true;
  await wait(3000);
  out.basicShadow = await measure();
  r.shadowMap.type = out.shadowType;
  for (const m of allMats()) m.needsUpdate = true;
  r.shadowMap.needsUpdate = true;
  await wait(3000);
  // Transparent overlays: which ones cost; list the biggest by screen-ish size.
  const tr = [];
  o.scene.traverse((x) => {
    if (x.visible && x.isMesh && !Array.isArray(x.material) && x.material.transparent) tr.push(x);
  });
  const names = {};
  for (const x of tr) {
    const top = x;
    const path = [];
    for (let p = x; p && path.length < 3; p = p.parent) path.push(p.name || p.type);
    const k = `${x.material.type}:${x.material.opacity.toFixed(2)}:${x.material.blending}:${path.join('<')}`;
    names[k] = (names[k] ?? 0) + 1;
    void top;
  }
  out.transparent = Object.entries(names)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  out.back = await measure();
  return out;
})();
