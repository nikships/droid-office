(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const g = o.scene.getObjectByName('vr-static-batches');
  let verts = 0,
    tris = 0,
    big = [];
  for (const m of g?.children ?? []) {
    const n = m.geometry.attributes.position.count;
    verts += n;
    tris += (m.geometry.index?.count ?? n) / 3;
    m.geometry.computeBoundingBox();
    const sz = m.geometry.boundingBox.getSize(o.camera.position.clone());
    big.push([
      n,
      sz
        .toArray()
        .map((v) => +v.toFixed(1))
        .join('x'),
      m.material.type,
    ]);
  }
  big.sort((a, b) => b[0] - a[0]);
  let frameTris = 0;
  const R = r.render;
  r.render = function (a, b) {
    R.call(this, a, b);
    frameTris = r.info.render.triangles;
  };
  await new Promise((d) => s.requestAnimationFrame(() => s.requestAnimationFrame(d)));
  r.render = R;
  return { batches: g?.children.length, verts, tris: Math.round(tris), frameTris, top: big.slice(0, 8) };
})();
