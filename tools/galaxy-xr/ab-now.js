// What's left, on the XRWebGLLayer build. The batcher is frozen while shader toggles recompile.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const b = o.vr.batcher;
  if (!b.__frozen) {
    b.__check = b.check;
    b.check = () => false;
    b.__frozen = true;
  }
  let M = null;
  o.scene.traverse((x) => {
    if (!M && x.material?.type === 'MeshToonMaterial') M = x.material;
  });
  let proto = Object.getPrototypeOf(M);
  while (proto && !Object.hasOwn(proto, 'onBeforeCompile')) proto = Object.getPrototypeOf(proto);
  const orig = (window.__origOBC4 ??= proto.onBeforeCompile);
  const mats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const use = (fn) => {
    proto.onBeforeCompile = fn;
    for (const m of mats()) if (!Object.hasOwn(m, 'onBeforeCompile')) m.needsUpdate = true;
  };
  const patch = (tag, edit) => {
    const f = new Function('orig', 'edit', `return function (s, r) { /*${tag}*/ orig.call(this, s, r); edit(s); };`)(orig, edit);
    return { on: () => use(f), off: () => use(orig), settle: 3500 };
  };
  const labels = [];
  const texs = new Set();
  o.scene.traverse((x) => {
    const m = x.material;
    if (!m || Array.isArray(m)) return;
    if (m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry') labels.push(x);
    for (const t of [m.map, m.emissiveMap]) if (t && t.anisotropy > 1) texs.add(t);
  });
  const aniso = (n) => {
    for (const t of texs) {
      t.__a ??= t.anisotropy;
      t.anisotropy = n === null ? t.__a : n;
      t.needsUpdate = true;
    }
  };
  const V = (window.__glViewport ??= gl.viewport);
  const tiny = function (x, y, w, h) {
    return V.call(this, x / 8, y / 8, Math.max(1, w / 8), Math.max(1, h / 8));
  };
  const R = (window.__render ??= r.render);
  const L = (window.__layersUpdate ??= o.vr.layers.update);
  window.__ab = {
    tinyViewport: {
      on: () => {
        gl.viewport = tiny;
      },
      off: () => {
        gl.viewport = V;
      },
    },
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
    [`noLabels${labels.length}`]: {
      on: () => {
        for (const x of labels) x.visible = false;
      },
      off: () => {
        for (const x of labels) x.visible = true;
      },
    },
    [`aniso1of${texs.size}`]: { on: () => aniso(1), off: () => aniso(null), settle: 1200 },
    noShadowSample: patch('nss', (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', '#undef USE_SHADOWMAP\n#include <lights_fragment_begin>');
    }),
    noScreens: patch('nsc', (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('+ skyScreensAt( vSkyWorld, skyN );', ';');
    }),
    noQuadLayers: {
      on: () => {
        o.vr.layers.clear();
        o.vr.layers.update = () => {};
      },
      off: () => {
        o.vr.layers.update = L;
      },
      settle: 800,
    },
  };
  if (window.__abPick) window.__ab = Object.fromEntries(window.__abPick.map((k) => [k, window.__ab[k] ?? Object.entries(window.__ab).find(([n]) => n.startsWith(k))?.[1]]));
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return Object.keys(window.__ab);
})();
