(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  const mats = new Map();
  o.scene.traverse((x) => {
    const ms = Array.isArray(x.material) ? x.material : x.material ? [x.material] : [];
    for (const m of ms) mats.set(m, m.version);
  });
  const props = r.properties;
  const targets = new Map();
  const SRT = r.setRenderTarget;
  r.setRenderTarget = function (t, ...a) {
    const k = t ? `${t.isXRRenderTarget ? 'xr' : 'rt'}:${t.texture?.name || `${t.width}x${t.height}`}:${t.texture?.colorSpace}` : 'null';
    targets.set(k, (targets.get(k) ?? 0) + 1);
    return SRT.call(this, t, ...a);
  };
  let renders = 0;
  const R = r.render;
  const scenes = new Map();
  r.render = function (sc, cam) {
    renders++;
    const k = `${sc.name || sc.type}/${cam.type}`;
    scenes.set(k, (scenes.get(k) ?? 0) + 1);
    return R.call(this, sc, cam);
  };
  // Sample light state versions via a known lit material's properties.
  let lit = null;
  for (const m of mats.keys())
    if (m.type === 'MeshToonMaterial') {
      lit = m;
      break;
    }
  const lv = [];
  for (let i = 0; i < 10; i++) {
    await f();
    const p = props.get(lit);
    lv.push(p?.lightsStateVersion);
  }
  r.setRenderTarget = SRT;
  r.render = R;
  let changed = 0;
  const who = {};
  for (const [m, v] of mats)
    if (m.version !== v) {
      changed++;
      const k = `${m.type}:${m.name}`;
      who[k] = (who[k] ?? 0) + (m.version - v);
    }
  const p = props.get(lit);
  return {
    renders,
    scenes: [...scenes],
    targets: [...targets],
    materials: mats.size,
    changedMaterials: changed,
    who: Object.entries(who).slice(0, 15),
    lightVersions: lv,
    litProps: { ocs: p?.outputColorSpace, needsLights: p?.needsLights, fog: !!p?.fog },
  };
})();
