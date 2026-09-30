// Details of the costly transparent groups: path, world size, texture size, distance.
(() => {
  const o = window.__office;
  const V = o.camera.position.constructor;
  const eye = new V();
  o.renderer.xr.getCamera().getWorldPosition(eye);
  const rows = [];
  o.scene.traverse((x) => {
    if (!x.visible || !x.material || Array.isArray(x.material) || !x.material.transparent) return;
    for (let p = x.parent; p; p = p.parent) if (!p.visible) return;
    const m = x.material;
    const hit = (m.depthWrite && m.opacity === 1 && m.map && x.geometry?.type === 'PlaneGeometry') || m.blending === 5 || m.opacity < 0.02 || x.geometry?.type === 'CircleGeometry' || (m.opacity > 0.3 && m.opacity < 0.4);
    if (!hit) return;
    const path = [];
    for (let p = x; p && path.length < 5; p = p.parent) path.push(p.name || p.userData?.panel?.constructor?.name || p.type);
    if (!x.geometry.boundingBox) x.geometry.computeBoundingBox();
    const sz = x.geometry.boundingBox.getSize(new V()).multiply(x.getWorldScale(new V()));
    const img = m.map?.image;
    rows.push({
      path: path.join('<'),
      size: sz.toArray().map((v) => +v.toFixed(2)),
      tex: img ? `${img.width}x${img.height}` : '',
      dist: +x.getWorldPosition(new V()).distanceTo(eye).toFixed(1),
      blend: m.blending,
      op: m.opacity,
      order: x.renderOrder,
      layer: x.userData.layered ?? '',
      ud: Object.keys(x.userData).join(','),
    });
  });
  return rows;
})();
