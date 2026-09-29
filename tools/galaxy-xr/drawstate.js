// Every visible draw's state that can switch off Adreno's LRZ (hidden-surface removal) for the whole
// pass: depth writes combined with blending or with discard (alphaTest / alphaHash / alphaToCoverage).
(() => {
  const o = window.__office;
  const rows = new Map();
  o.scene.traverse((x) => {
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) {
      let vis = x.visible;
      for (let q = x.parent; q && vis; q = q.parent) if (!q.visible) vis = false;
      if (!vis || !m.visible || !x.layers.isEnabled(0)) continue;
      const blend = m.transparent && m.blending !== 0;
      const discard = m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage;
      const dw = m.depthWrite && m.depthTest;
      const bad = dw && (blend || discard);
      const colorOff = m.colorWrite === false;
      if (!bad && !colorOff) continue;
      const k = `${m.type} transp=${m.transparent} blend=${m.blending} alphaTest=${m.alphaTest} dw=${m.depthWrite} colorWrite=${m.colorWrite} depthFunc=${m.depthFunc} map=${!!m.map}`;
      const r = rows.get(k) ?? { n: 0, eg: x.name || x.parent?.name || '?' };
      r.n++;
      rows.set(k, r);
    }
  });
  return [...rows].map(([k, v]) => `${v.n}x ${k} e.g. ${v.eg}`);
})();
