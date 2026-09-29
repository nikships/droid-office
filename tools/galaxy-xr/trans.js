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
  const byMat = new Map();
  o.scene.traverse((x) => {
    if (!x.visible || !x.isMesh || Array.isArray(x.material) || !x.material.transparent) return;
    const m = x.material;
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(x);
  });
  const groups = [...byMat].sort((a, b) => b[1].length - a[1].length);
  const out = { base: await measure(), groups: groups.length };
  for (const [m, list] of groups.slice(0, 6)) {
    for (const x of list) x.visible = false;
    await wait(300);
    out[`${list.length}x ${m.type} op=${m.opacity.toFixed(2)} ${m.color?.getHexString()} ${m.map ? 'map' : ''}`] = await measure();
    for (const x of list) x.visible = true;
  }
  // Dynamic viewport scaling support.
  let vs = null;
  await new Promise((d) =>
    s.requestAnimationFrame((_t, f) => {
      const pose = f.getViewerPose(r.xr.getReferenceSpace());
      const v = pose?.views[0];
      vs = { requestViewportScale: typeof v?.requestViewportScale, recommended: v?.recommendedViewportScale ?? null };
      d();
    }),
  );
  out.viewportScale = vs;
  return out;
})();
