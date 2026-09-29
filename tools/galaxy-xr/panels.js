// Every WorldPanel in the scene: visible or not, size, canvas, distance, whether it has a quad layer.
(() => {
  const o = window.__office;
  const cam = o.renderer.xr.getCamera();
  const V = cam.position.constructor;
  const out = [];
  o.scene.traverse((x) => {
    const p = x.userData?.panel;
    if (!p) return;
    let vis = true;
    for (let q = x; q; q = q.parent) if (!q.visible) vis = false;
    const w = new V();
    x.getWorldPosition(w);
    let name = '';
    for (let q = x; q && !name; q = q.parent) name = q.name;
    out.push({ name, vis, m: `${p.width}x${p.height}`, canvas: `${p.canvasW}x${p.canvasH}`, dist: +w.distanceTo(cam.position).toFixed(2), order: p.order, blending: x.material.blending });
  });
  const ui = o.vr.ui ?? {};
  return { panels: out, ui: Object.keys(ui) };
})();
