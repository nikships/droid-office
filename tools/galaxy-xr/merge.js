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
  const settle = () => new Promise((d) => setTimeout(d, 800));
  const out = {};
  const dolly = o.vr.dolly;
  const underDolly = (x) => {
    for (let p = x; p; p = p.parent) if (p === dolly) return true;
    return false;
  };
  // Group every plain visible mesh by material.
  const groups = new Map();
  o.scene.updateMatrixWorld(true);
  const isVisible = (x) => {
    for (let p = x; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  o.scene.traverse((x) => {
    if (!x.isMesh || x.isSkinnedMesh || x.isInstancedMesh || Array.isArray(x.material) || underDolly(x) || !isVisible(x)) return;
    const g = x.geometry;
    if (!g.attributes.position || g.morphAttributes?.position) return;
    const key = `${x.material.uuid}|${Object.keys(g.attributes).sort().join(',')}`;
    if (!groups.has(key)) groups.set(key, { mat: x.material, meshes: [] });
    groups.get(key).meshes.push(x);
  });
  out.uniqueMaterials = new Set([...groups.values()].map((g) => g.mat)).size;
  out.groups = groups.size;
  out.mergeableMeshes = [...groups.values()].reduce((a, g) => a + g.meshes.length, 0);
  const Mesh = [...groups.values()][0].meshes[0].constructor;
  const Geo = [...groups.values()][0].meshes[0].geometry.constructor;
  const Attr = [...groups.values()][0].meshes[0].geometry.attributes.position.constructor;
  const v = [...groups.values()][0].meshes[0].position.constructor;
  const tmp = new v();
  const merged = [];
  for (const { mat, meshes } of groups.values()) {
    if (meshes.length < 2) continue;
    const names = Object.keys(meshes[0].geometry.attributes);
    let vcount = 0,
      icount = 0;
    for (const m of meshes) {
      const g = m.geometry;
      vcount += g.attributes.position.count;
      icount += g.index ? g.index.count : g.attributes.position.count;
    }
    const arrays = {};
    for (const n of names) arrays[n] = new Float32Array(vcount * meshes[0].geometry.attributes[n].itemSize);
    const idx = new Uint32Array(icount);
    let vo = 0,
      io = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const pc = g.attributes.position.count;
      for (const n of names) {
        const a = g.attributes[n];
        const dst = arrays[n];
        const sz = a.itemSize;
        for (let i = 0; i < pc; i++) {
          if (n === 'position') {
            tmp.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld);
            dst[(vo + i) * 3] = tmp.x;
            dst[(vo + i) * 3 + 1] = tmp.y;
            dst[(vo + i) * 3 + 2] = tmp.z;
          } else if (n === 'normal') {
            tmp.fromBufferAttribute(a, i).transformDirection(m.matrixWorld);
            dst[(vo + i) * 3] = tmp.x;
            dst[(vo + i) * 3 + 1] = tmp.y;
            dst[(vo + i) * 3 + 2] = tmp.z;
          } else for (let k = 0; k < sz; k++) dst[(vo + i) * sz + k] = a.array[i * sz + k] ?? 0;
        }
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
      else for (let i = 0; i < pc; i++) idx[io++] = vo + i;
      vo += pc;
    }
    const geo = new Geo();
    for (const n of names) geo.setAttribute(n, new Attr(arrays[n], meshes[0].geometry.attributes[n].itemSize));
    geo.setIndex(new Attr(idx, 1));
    const mm = new Mesh(geo, mat);
    mm.frustumCulled = false;
    mm.receiveShadow = meshes.some((m) => m.receiveShadow);
    mm.castShadow = meshes.some((m) => m.castShadow);
    merged.push({ mm, meshes });
  }
  out.mergedDraws = merged.length;
  for (const { mm, meshes } of merged) {
    for (const m of meshes) m.visible = false;
    o.scene.add(mm);
  }
  await settle();
  r.info.reset();
  out.merged = await measure();
  out.mergedCalls = r.info.render.calls;
  for (const { mm, meshes } of merged) {
    for (const m of meshes) m.visible = true;
    o.scene.remove(mm);
    mm.geometry.dispose();
  }
  await settle();
  out.baselineAgain = await measure();
  return out;
})();
