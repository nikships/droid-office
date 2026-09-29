// What the draw calls are: per-object counts in one XR frame, grouped by reason it isn't merged.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  const seen = new Map();
  const RBD = r.renderBufferDirect;
  r.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    seen.set(obj, (seen.get(obj) ?? 0) + 1);
    return RBD.call(this, cam, scene, geo, mat, obj, group);
  };
  await f();
  seen.clear();
  await f();
  r.renderBufferDirect = RBD;
  const root = o.office.group;
  const b = o.vr.batcher;
  const buckets = {};
  let total = 0;
  for (const [x, n] of seen) {
    total += n;
    let under = false;
    for (let p = x; p; p = p.parent) if (p === root) under = true;
    const m = Array.isArray(x.material) ? null : x.material;
    let why;
    if (x.parent?.name === 'vr-static-batches') why = 'merged';
    else if (!under) {
      let top = x;
      while (top.parent && top.parent !== o.scene) top = top.parent;
      why = `outside:${top.name || top.type}`;
    } else if (!x.isMesh) why = x.type;
    else if (Array.isArray(x.material)) why = 'material-array';
    else if (m.transparent) why = `transparent:${m.type}`;
    else if (b.isDynamic?.(x)) why = 'moved';
    else if (x.userData.panel) why = 'panel';
    else why = 'solo';
    buckets[why] = (buckets[why] ?? 0) + n;
  }
  return { total, objects: seen.size, buckets: Object.entries(buckets).sort((a, c) => c[1] - a[1]) };
})();
