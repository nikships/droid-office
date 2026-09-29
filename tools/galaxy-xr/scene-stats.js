// One XR frame's triangles and draws, the Standard/Physical meshes, and the label textures' filtering.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  r.info.autoReset = false;
  await f();
  r.info.reset();
  await f();
  const info = { tris: r.info.render.triangles, calls: r.info.render.calls, points: r.info.render.points };
  r.info.autoReset = true;
  const V = o.camera.position.constructor;
  const pbr = [];
  const byTris = [];
  o.scene.traverse((x) => {
    if (!x.isMesh || !x.visible) return;
    for (let p = x.parent; p; p = p.parent) if (!p.visible) return;
    if (!x.layers.isEnabled(0)) return;
    const tris = (x.geometry.index?.count ?? x.geometry.attributes.position?.count ?? 0) / 3;
    const path = [];
    for (let p = x; p && path.length < 4; p = p.parent) path.push(p.name || p.type);
    byTris.push([tris | 0, path.join('<'), x.geometry.type, Array.isArray(x.material) ? 'arr' : x.material.type]);
    const ms = Array.isArray(x.material) ? x.material : [x.material];
    if (ms.some((m) => m.type === 'MeshStandardMaterial' || m.type === 'MeshPhysicalMaterial')) {
      if (!x.geometry.boundingBox) x.geometry.computeBoundingBox();
      const sz = x.geometry.boundingBox.getSize(new V()).multiply(x.getWorldScale(new V()));
      pbr.push([
        path.join('<'),
        ms.map((m) => m.type).join(),
        sz
          .toArray()
          .map((v) => +v.toFixed(1))
          .join('x'),
      ]);
    }
  });
  byTris.sort((a, b) => b[0] - a[0]);
  return { info, pbr, topTris: byTris.slice(0, 15), meshTris: byTris.reduce((a, b) => a + b[0], 0), meshes: byTris.length, attrs: r.getContext().getContextAttributes() };
})();
