(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 90) {
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
  const settle = () => new Promise((d) => setTimeout(d, 700));
  const out = {};
  // Time the pieces of one frame on the CPU.
  const R = r.render;
  let rt = 0,
    rn = 0;
  r.render = function (a, b) {
    const t0 = performance.now();
    R.call(this, a, b);
    rt += performance.now() - t0;
    rn++;
  };
  const vu = o.vr.update;
  let vt = 0;
  o.vr.update = function (dt) {
    const t0 = performance.now();
    vu.call(this, dt);
    vt += performance.now() - t0;
  };
  const b = await measure(60);
  out.baseline = { ...b, renderMs: +(rt / rn).toFixed(1), vrUpdateMs: +(vt / 60).toFixed(1) };
  r.render = R;
  o.vr.update = vu;

  // Where is the scene? Biggest subtrees by draw count.
  const rows = [];
  for (const c of o.scene.children) {
    let n = 0,
      tris = 0,
      tr = 0;
    c.traverse((x) => {
      if (x.isMesh && x.visible) {
        n++;
        if (x.material?.transparent) tr++;
        const g = x.geometry;
        tris += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
      }
    });
    if (n) rows.push({ name: c.name || c.type, meshes: n, transparent: tr, ktris: Math.round(tris / 1000), visible: c.visible });
  }
  out.subtrees = rows.sort((a, b) => b.meshes - a.meshes).slice(0, 15);

  // Per subtree: hide it and see what fps comes back.
  const top = out.subtrees.filter((x) => x.visible).slice(0, 6);
  out.hideEach = [];
  for (const row of top) {
    const c = o.scene.children.find((x) => (x.name || x.type) === row.name && x.visible);
    if (!c) continue;
    c.visible = false;
    await settle();
    const m = await measure(60);
    c.visible = true;
    out.hideEach.push({ name: row.name, ...m });
    await settle();
  }
  // Pixel-bound test: shrink the viewport so each eye draws a quarter of the pixels.
  const gl = r.getContext();
  const vp = gl.viewport.bind(gl);
  gl.viewport = (x, y, w, h) => vp(x / 2, y / 2, w / 2, h / 2);
  await settle();
  out.quarterPixels = await measure(60);
  gl.viewport = vp;
  await settle();
  out.baselineAgain = await measure(60);
  return out;
})();
