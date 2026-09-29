(() => {
  const o = window.__office;
  const V = o.camera.position.constructor;
  const out = {};
  for (const id of [4613, 2718, 2719, 4130]) {
    const g = o.scene.getObjectById(id);
    if (!g) continue;
    const items = [];
    g.traverse((x) => {
      if (!x.isMesh && !x.isPoints) return;
      x.geometry.computeBoundingBox?.();
      const bb = x.geometry.boundingBox;
      const size = bb
        ? bb
            .getSize(new V())
            .multiply(x.getWorldScale(new V()))
            .toArray()
            .map((v) => +v.toFixed(2))
        : null;
      const m = x.material;
      items.push({
        name: x.name,
        type: x.type,
        geo: x.geometry.type,
        size,
        mat: `${m.type} op=${m.opacity} blend=${m.blending} dt=${m.depthTest} dw=${m.depthWrite} side=${m.side} map=${!!m.map} fog=${m.fog}`,
        visible: x.visible,
        frustum: x.frustumCulled,
        order: x.renderOrder,
      });
    });
    out[id] = { name: g.name, userData: Object.keys(g.userData), items };
  }
  return out;
})();
