// Per-mesh raycast cost during VR picks: which meshes eat the time, and how many get tested at all.
(async () => {
  const o = window.__office;
  const _s = o.renderer.xr.getSession();
  const stats = new Map();
  let tested = 0,
    calls = 0;
  const wrapped = [];
  o.office.group.traverse((x) => {
    if (!x.isMesh || x.raycast === undefined) return;
    const orig = x.raycast;
    wrapped.push([x, Object.hasOwn(x, 'raycast') ? orig : null]);
    x.raycast = function (rc, hits) {
      const t0 = performance.now();
      const n0 = hits.length;
      orig.call(this, rc, hits);
      const dt = performance.now() - t0;
      tested++;
      const e = stats.get(this) ?? { ms: 0, n: 0, hits: 0 };
      e.ms += dt;
      e.n++;
      e.hits += hits.length - n0;
      stats.set(this, e);
    };
  });
  const pf = o.vr.hooks.pickFromRay;
  o.vr.hooks.pickFromRay = (...a) => {
    calls++;
    return pf(...a);
  };
  await new Promise((d) => setTimeout(d, 3000));
  o.vr.hooks.pickFromRay = pf;
  for (const [x, own] of wrapped) {
    if (own) x.raycast = own;
    else delete x.raycast;
  }
  const rows = [...stats]
    .map(([m, e]) => {
      const g = m.geometry;
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const path = [];
      for (let p = m; p && path.length < 3; p = p.parent) path.push(p.name || p.type);
      return { ms: +e.ms.toFixed(1), per: +(e.ms / e.n).toFixed(3), n: e.n, tris, geo: g.type, path: path.join('<'), hits: e.hits };
    })
    .sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((a, r) => a + r.ms, 0);
  return { picks: calls, meshesTestedPerPick: +(tested / calls).toFixed(0), totalMs: +total.toFixed(1), msPerPick: +(total / calls).toFixed(2), top: rows.slice(0, 15) };
})();
