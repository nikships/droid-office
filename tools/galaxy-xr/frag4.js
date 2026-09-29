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
      setTimeout(d, 6000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const mats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const attrs = r.getContext().getContextAttributes();
  const out = { antialias: attrs.antialias, base: await measure() };
  // Front to back, ignoring program grouping: Adreno's LRZ then rejects hidden pixels early.
  r.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
  await wait(800);
  out.frontToBack = await measure();
  r.setOpaqueSort(null);
  await wait(800);
  const was = new Map();
  for (const m of mats()) {
    was.set(m, m.precision);
    m.precision = 'mediump';
    m.needsUpdate = true;
  }
  await wait(4000);
  out.mediump = await measure();
  r.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
  await wait(800);
  out.both = await measure();
  r.setOpaqueSort(null);
  for (const [m, p] of was) {
    m.precision = p;
    m.needsUpdate = true;
  }
  await wait(4000);
  out.back = await measure();
  return out;
})();
