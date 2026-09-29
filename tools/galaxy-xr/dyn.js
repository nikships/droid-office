// Which drawn meshes the batcher called dynamic, and whether they really move or recolor now.
(async () => {
  const o = window.__office;
  const s = o.renderer.xr.getSession();
  const b = o.vr.batcher;
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  const dyn = [];
  o.office.group.traverse((x) => {
    if (x.isMesh && b.isDynamic(x)) dyn.push(x);
  });
  const m0 = dyn.map((x) => x.matrixWorld.clone());
  const st = (m) => `${m.version}|${m.color?.getHex()}|${m.emissive?.getHex()}|${m.opacity}`;
  const s0 = dyn.map((x) => (Array.isArray(x.material) ? x.material : [x.material]).map(st).join());
  for (let i = 0; i < 90; i++) await frame();
  const rows = {};
  dyn.forEach((x, i) => {
    const moved = !x.matrixWorld.equals(m0[i]);
    const rec = (Array.isArray(x.material) ? x.material : [x.material]).map(st).join() !== s0[i];
    const path = [];
    for (let p = x; p && p !== o.office.group && path.length < 4; p = p.parent) path.push(p.name || p.userData?.interact?.kind || p.type);
    const k = `${moved ? 'MOVES' : rec ? 'RECOLORS' : 'still'} ${x.geometry.type} ${path.join('<')}`;
    rows[k] = (rows[k] ?? 0) + 1;
  });
  return {
    dynamic: dyn.length,
    rows: Object.entries(rows)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 20),
  };
})();
