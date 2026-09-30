(async () => {
  const o = window.__office;
  const out = {};
  o.office.group.traverse((x) => {
    if (!x.isMesh || !Array.isArray(x.material) || !x.layers.isEnabled(0)) return;
    for (let p = x; p; p = p.parent) if (!p.visible) return;
    const g = x.geometry;
    const k = `${g.type} groups=${g.groups.length} mats=${x.material.length} uniq=${new Set(x.material).size} [${[...new Set(x.material.map((m) => m.type + (m.map ? '+map' : '') + (m.transparent ? '+T' : '')))].join(',')}] name=${x.name || x.parent?.name || ''}`;
    out[k] = (out[k] ?? 0) + 1;
  });
  return Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
})();
