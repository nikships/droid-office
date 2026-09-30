(() => {
  const o = window.__office;
  const V = o.camera.position.constructor;
  const pick = [];
  const labels = [];
  o.scene.traverse((x) => {
    if (!x.visible || !x.material || Array.isArray(x.material) || !x.material.transparent) return;
    for (let p = x.parent; p; p = p.parent) if (!p.visible) return;
    const m = x.material;
    if (m.depthWrite && m.opacity === 1 && m.map && x.geometry?.type === 'PlaneGeometry') labels.push(x);
    else if (m.blending === 5 || m.opacity < 0.02 || x.geometry?.type === 'CircleGeometry' || (m.opacity > 0.3 && m.opacity < 0.4)) pick.push(x);
  });
  const info = (x) => {
    if (!x.geometry.boundingBox) x.geometry.computeBoundingBox();
    const s = x.geometry.boundingBox.getSize(new V()).multiply(x.getWorldScale(new V()));
    return `${x.type}/${x.geometry.type} op=${x.material.opacity.toFixed(2)} ${s
      .toArray()
      .map((v) => v.toFixed(1))
      .join('x')} tris=${((x.geometry.index?.count ?? x.geometry.attributes.position.count) / 3) | 0}`;
  };
  window.__ab = {};
  for (const x of pick)
    window.__ab[info(x)] = {
      on: () => {
        x.visible = false;
      },
      off: () => {
        x.visible = true;
      },
    };
  const t = labels[0].material.map;
  window.__labelInfo = labels.map((x) => {
    const mt = x.material.map;
    return `${mt.minFilter}/${mt.generateMipmaps}/${mt.anisotropy}/${mt.image.width}`;
  });
  return { toggles: Object.keys(window.__ab), label: { minFilter: t.minFilter, mip: t.generateMipmaps, aniso: t.anisotropy, all: [...new Set(window.__labelInfo.map((s) => s.split('/').slice(0, 3).join('/')))] } };
})();
