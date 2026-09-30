// Scene census two levels deep: visible meshes, triangles, and draws issued per subtree in one XR frame.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const drawn = new Map();
  const RBD = r.renderBufferDirect;
  r.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    drawn.set(obj, (drawn.get(obj) ?? 0) + 1);
    return RBD.call(this, cam, scene, geo, mat, obj, group);
  };
  await new Promise((d) => s.requestAnimationFrame(d));
  await new Promise((d) => s.requestAnimationFrame(d));
  r.renderBufferDirect = RBD;
  const tris = (g) => (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
  const stat = (root) => {
    let meshes = 0,
      t = 0,
      draws = 0,
      drawTris = 0;
    root.traverse((x) => {
      if (!x.isMesh && !x.isPoints && !x.isLine && !x.isSprite) return;
      let vis = true;
      for (let q = x; q; q = q.parent) if (!q.visible) vis = false;
      if (!vis) return;
      meshes++;
      const n = x.geometry ? tris(x.geometry) * (x.isInstancedMesh ? x.count : 1) : 0;
      t += n;
      const d = drawn.get(x) ?? 0;
      draws += d;
      if (d) drawTris += (n * d) / 2;
    });
    return { meshes, ktris: +(t / 1000).toFixed(1), draws: +(draws / 2).toFixed(0), drawnKtris: +(drawTris / 1000).toFixed(1) };
  };
  const label = (x) => `${x.name || x.type}${x.visible ? '' : ' (hidden)'}`;
  const rows = [];
  for (const c of o.scene.children) {
    rows.push({ path: label(c), ...stat(c) });
    if (c.children.length > 1 && c.children.length < 40)
      for (const k of c.children) {
        const st = stat(k);
        if (st.draws > 2 || st.drawnKtris > 20) rows.push({ path: `  ${label(c)}/${label(k)}`, ...st });
      }
  }
  return { total: stat(o.scene), rows };
})();
