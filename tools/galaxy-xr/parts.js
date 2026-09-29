// office.group's and the scene's direct children: meshes, triangles and world bounds, to find the outside parts.
(() => {
  const o = window.__office;
  const _B3 = o.scene.children.find((c) => c.isMesh)?.geometry?.boundingBox?.constructor;
  const rows = [];
  const add = (where, c, i) => {
    let meshes = 0,
      tris = 0;
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    c.updateWorldMatrix(true, true);
    c.traverse((x) => {
      if (!x.isMesh || !x.geometry?.attributes.position) return;
      let vis = true;
      for (let q = x; q && q !== c.parent; q = q.parent) if (!q.visible) vis = false;
      if (!vis) return;
      meshes++;
      const g = x.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      g.computeBoundingSphere();
      const s = g.boundingSphere;
      const e = x.matrixWorld.elements;
      const cx = e[0] * s.center.x + e[4] * s.center.y + e[8] * s.center.z + e[12];
      const cy = e[1] * s.center.x + e[5] * s.center.y + e[9] * s.center.z + e[13];
      const cz = e[2] * s.center.x + e[6] * s.center.y + e[10] * s.center.z + e[14];
      box.minX = Math.min(box.minX, cx);
      box.maxX = Math.max(box.maxX, cx);
      box.minY = Math.min(box.minY, cy);
      box.maxY = Math.max(box.maxY, cy);
      box.minZ = Math.min(box.minZ, cz);
      box.maxZ = Math.max(box.maxZ, cz);
    });
    if (!meshes) return;
    const f = (a, b) => `${a.toFixed(0)}..${b.toFixed(0)}`;
    rows.push(
      `${where}[${i}] ${c.name || c.type}${c.visible ? '' : ' (hidden)'} kids=${c.children.length} meshes=${meshes} ktris=${(tris / 1000).toFixed(1)} x ${f(box.minX, box.maxX)} y ${f(box.minY, box.maxY)} z ${f(box.minZ, box.maxZ)}`,
    );
  };
  o.office.group.children.forEach((c, i) => add('office', c, i));
  o.scene.children.forEach((c, i) => {
    if (c !== o.office.group) add('scene', c, i);
  });
  return rows;
})();
