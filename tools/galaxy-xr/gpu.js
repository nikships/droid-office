(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 60) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 7000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const settle = () => new Promise((d) => setTimeout(d, 800));
  const allMats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const out = { base: await measure() };

  // Transparent draws hidden.
  const tr = [];
  o.scene.traverse((x) => {
    if (x.visible && x.material && !Array.isArray(x.material) && x.material.transparent) {
      tr.push(x);
      x.visible = false;
    }
  });
  await settle();
  out.noTransparent = await measure();
  out.transparentCount = tr.length;
  for (const x of tr) x.visible = true;

  // Shadow receiving off (shader without shadow map lookups).
  r.shadowMap.enabled = false;
  for (const m of allMats()) m.needsUpdate = true;
  await settle();
  await settle();
  out.noShadows = await measure();
  r.shadowMap.enabled = true;
  for (const m of allMats()) m.needsUpdate = true;
  r.shadowMap.needsUpdate = true;
  await settle();
  await settle();

  // Lights: count and all but the strongest off.
  const lights = [];
  o.scene.traverse((x) => {
    if (x.isLight && x.visible && !x.isAmbientLight && !x.isHemisphereLight) lights.push(x);
  });
  out.lights = lights.map((l) => `${l.type}${l.castShadow ? '*' : ''}`).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
  const keep = lights.filter((l) => l.isDirectionalLight);
  for (const l of lights) if (!keep.includes(l)) l.visible = false;
  await settle();
  await settle();
  out.onlyDirectional = await measure();
  for (const l of lights) l.visible = true;
  await settle();
  await settle();

  // Fog off.
  const fog = o.scene.fog;
  o.scene.fog = null;
  for (const m of allMats()) m.needsUpdate = true;
  await settle();
  await settle();
  out.noFog = await measure();
  o.scene.fog = fog;
  for (const m of allMats()) m.needsUpdate = true;
  await settle();
  out.after = await measure();
  return out;
})();
