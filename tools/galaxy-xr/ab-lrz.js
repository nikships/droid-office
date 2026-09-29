// Why 22 small labels cost ~10 fps: arms change only their depth-write / discard state.
(() => {
  const o = window.__office;
  const b = o.vr.batcher;
  if (!b.__frozen) {
    b.__check = b.check;
    b.check = () => false;
    b.__frozen = true;
  }
  const bad = [];
  const custom = [];
  o.scene.traverse((x) => {
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) {
      let vis = x.visible;
      for (let q = x.parent; q && vis; q = q.parent) if (!q.visible) vis = false;
      if (!vis || !x.layers.isEnabled(0)) continue;
      const blend = (m.transparent || m.blending !== 1) && m.blending !== 0;
      if (m.depthWrite && m.depthTest && (blend || m.alphaTest > 0)) bad.push(m);
      if (m.blending === 5) custom.push({ m, dw: m.depthWrite, t: m.transparent });
    }
  });
  const mats = [...new Set(bad)];
  const set = (k, v) => {
    for (const m of mats) {
      m[`__${k}`] ??= m[k];
      m[k] = v === null ? m[`__${k}`] : v;
      if (k === 'alphaTest') m.needsUpdate = true;
    }
  };
  const all = {
    noDepthWrite: { on: () => set('depthWrite', false), off: () => set('depthWrite', null) },
    noAlphaTest: { on: () => set('alphaTest', 0), off: () => set('alphaTest', null), settle: 1500 },
    hidden: {
      on: () => {
        for (const m of mats) m.visible = false;
      },
      off: () => {
        for (const m of mats) m.visible = true;
      },
    },
  };
  window.__ab = all;
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return { mats: mats.length, custom: custom.map((c) => `dw=${c.dw} transparent=${c.t}`), arms: Object.keys(all) };
})();
