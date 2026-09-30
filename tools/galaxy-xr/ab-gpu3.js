// Why ~22 small labels cost ~4 ms of GPU: split them by kind, and flip one state at a time.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const b = o.vr.batcher;
  if (!b.__frozen) {
    b.__check = b.check;
    b.check = () => false;
    b.__frozen = true;
  }
  const vis = (x) => {
    for (let q = x; q; q = q.parent) if (!q.visible) return false;
    return x.layers.isEnabled(0);
  };
  const text = [],
    punch = [];
  o.scene.traverse((x) => {
    const m = x.material;
    if (!m || Array.isArray(m) || !vis(x)) return;
    if (m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry') (m.blending === 5 ? punch : text).push(x);
  });
  const mats = [...new Set(text.map((x) => x.material))];
  const texs = [...new Set(mats.map((m) => m.map))];
  const hide = (list) => ({
    on: () => {
      for (const x of list) x.visible = false;
    },
    off: () => {
      for (const x of list) x.visible = true;
    },
  });
  const setm = (k, v, recompile) => ({
    on: () => {
      for (const m of mats) {
        m[`__${k}`] ??= m[k];
        m[k] = v;
        if (recompile) m.needsUpdate = true;
      }
    },
    off: () => {
      for (const m of mats) {
        if (`__${k}` in m) m[k] = m[`__${k}`];
        if (recompile) m.needsUpdate = true;
      }
    },
    settle: recompile ? 2000 : 600,
  });
  const tex = (fn) => ({
    on: () => {
      for (const t of texs) {
        t.__s ??= { a: t.anisotropy, g: t.generateMipmaps, mf: t.minFilter };
        fn(t);
        t.needsUpdate = true;
      }
    },
    off: () => {
      for (const t of texs) {
        if (t.__s) {
          t.anisotropy = t.__s.a;
          t.generateMipmaps = t.__s.g;
          t.minFilter = t.__s.mf;
          t.needsUpdate = true;
        }
      }
    },
    settle: 1500,
  });
  const R = (window.__render ??= r.render);
  window.__ab = {
    noRender: {
      on: () => {
        r.render = () => {
          r.clear();
        };
      },
      off: () => {
        r.render = R;
      },
    },
    noTextLabels: hide(text),
    noPunches: hide(punch),
    textOpaque: setm('transparent', false, true),
    textNoAlphaTest: setm('alphaTest', 0, true),
    textAniso1: tex((t) => {
      t.anisotropy = 1;
    }),
    textNoMips: tex((t) => {
      t.generateMipmaps = false;
      t.minFilter = 1006;
    }),
  };
  if (window.__abPick) window.__ab = Object.fromEntries(window.__abPick.map((k) => [k, window.__ab[k]]));
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return Object.keys(window.__ab).concat([`text=${text.length}`, `punch=${punch.length}`, `texs=${texs.length}`]);
})();
