// The 32 transparent textured planes: what they are, how big, which shader, and their screen area.
(() => {
  const o = window.__office;
  const cam = o.renderer.xr.getCamera();
  const THREE = { Vector3: o.scene.position.constructor };
  const out = [];
  o.scene.traverse((x) => {
    const m = x.material;
    if (!m || Array.isArray(m) || !(m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry')) return;
    const p = x.geometry.parameters;
    const s = new THREE.Vector3();
    x.getWorldScale(s);
    const w = new THREE.Vector3();
    x.getWorldPosition(w);
    const img = m.map.image;
    let vis = true;
    for (let q = x; q; q = q.parent) if (!q.visible) vis = false;
    out.push({
      name: x.name || x.parent?.name || '?',
      type: m.type,
      obc: m.onBeforeCompile?.toString().slice(0, 40),
      size: `${(p.width * s.x).toFixed(2)}x${(p.height * s.y).toFixed(2)}`,
      dist: +w.distanceTo(cam.position).toFixed(1),
      tex: img ? `${img.width}x${img.height}` : '?',
      mip: m.map.generateMipmaps,
      minF: m.map.minFilter,
      aniso: m.map.anisotropy,
      alphaTest: m.alphaTest,
      side: m.side,
      vis,
      fsp: m.forceSinglePass,
      blending: m.blending,
      prog: o.renderer.properties.get(m).currentProgram?.name,
    });
  });
  return out;
})();
