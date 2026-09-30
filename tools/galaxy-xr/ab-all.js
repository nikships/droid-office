// Every remaining GPU cost as abx.js toggles. The batcher is frozen while they run: a recompile
// bumps material versions, which the batcher would otherwise read as recolors and unbatch.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const b = o.vr.batcher;
  if (!b.__frozen) {
    b.__check = b.check;
    b.check = () => false;
    b.__frozen = true;
  }
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  let rt = null;
  const R = r.render;
  r.render = function (a, c) {
    rt = r.getRenderTarget();
    r.render = R;
    return R.call(this, a, c);
  };
  let M = null;
  o.scene.traverse((x) => {
    if (!M && x.material?.type === 'MeshToonMaterial') M = x.material;
  });
  let proto = Object.getPrototypeOf(M);
  while (proto && !Object.hasOwn(proto, 'onBeforeCompile')) proto = Object.getPrototypeOf(proto);
  const orig = (window.__origOBC3 ??= proto.onBeforeCompile);
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
  const samples = async (n) => {
    await frame();
    await frame();
    if (rt && rt.samples !== n) {
      rt.samples = n;
      r.properties.remove(rt);
    }
  };
  let hidden = [];
  const Basic = [...mats()].find((m) => m.type === 'MeshBasicMaterial').constructor;
  const basic = new Basic({ color: 0x808080 });
  const all = {
    msaa0: { on: () => samples(0), off: () => samples(4), settle: 600 },
    msaa2: { on: () => samples(2), off: () => samples(4), settle: 600 },
    noShadowSample: patch('nss', (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', '#undef USE_SHADOWMAP\n#include <lights_fragment_begin>');
    }),
    noScreens: patch('nsc', (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('+ skyScreensAt( vSkyWorld, skyN );', ';');
    }),
    noHaze: patch('nhz', (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(/float skyReach[\s\S]*?\);\n\s*float fogFactor = [^\n]*\n/, 'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );\n');
    }),
    noSkyAtAll: {
      on: () =>
        use((sh, rr) => {
          void sh;
          void rr;
        }),
      off: () => use(orig),
      settle: 3500,
    },
    noTransparent: {
      on: () => {
        hidden = [];
        o.scene.traverse((x) => {
          if (x.visible && x.material && !Array.isArray(x.material) && x.material.transparent) {
            hidden.push(x);
            x.visible = false;
          }
        });
      },
      off: () => {
        for (const x of hidden) x.visible = true;
        hidden = [];
      },
    },
    basicAll: {
      on: () => {
        o.scene.overrideMaterial = basic;
      },
      off: () => {
        o.scene.overrideMaterial = null;
      },
      settle: 1500,
    },
  };
  const pick = window.__abPick;
  window.__ab = pick ? Object.fromEntries(pick.map((k) => [k, all[k]])) : all;
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return Object.keys(window.__ab);
})();
