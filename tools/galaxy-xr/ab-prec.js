// Shader precision and shading-model levers. Batcher frozen: recompiles bump material versions.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const b = o.vr.batcher;
  if (!b.__frozen) {
    b.__check = b.check;
    b.check = () => false;
    b.__frozen = true;
  }
  const mats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const prec = (p) => {
    for (const m of mats()) {
      m.precision = p;
      m.needsUpdate = true;
    }
  };
  let M = null;
  o.scene.traverse((x) => {
    if (!M && x.material?.type === 'MeshToonMaterial') M = x.material;
  });
  let proto = Object.getPrototypeOf(M);
  while (proto && !Object.hasOwn(proto, 'onBeforeCompile')) proto = Object.getPrototypeOf(proto);
  const orig = (window.__origOBC5 ??= proto.onBeforeCompile);
  const use = (fn) => {
    proto.onBeforeCompile = fn;
    for (const m of mats()) if (!Object.hasOwn(m, 'onBeforeCompile')) m.needsUpdate = true;
  };
  // mediump for the fragment shader only: a default-precision statement after three's prefix.
  const fragMedium = function (s, rr) {
    orig.call(this, s, rr);
    s.fragmentShader = `precision mediump float;\n${s.fragmentShader}`;
  };
  const all = {
    mediumpAll: { on: () => prec('mediump'), off: () => prec(null), settle: 4000 },
    mediumpFrag: { on: () => use(fragMedium), off: () => use(orig), settle: 4000 },
    info: null,
  };
  delete all.info;
  window.__ab = window.__abPick ? Object.fromEntries(window.__abPick.map((k) => [k, all[k]])) : all;
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return { toneMapping: r.toneMapping, shadowType: r.shadowMap.type, shadowAuto: r.shadowMap.autoUpdate, capsPrecision: r.capabilities.precision, arms: Object.keys(window.__ab) };
})();
