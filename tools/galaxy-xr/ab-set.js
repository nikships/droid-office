// Candidate GPU savings as abx.js toggles.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  let rt = null;
  const R = r.render;
  r.render = function (a, b) {
    rt = r.getRenderTarget();
    r.render = R;
    return R.call(this, a, b);
  };
  const mats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const recompile = () => {
    for (const m of mats()) m.needsUpdate = true;
  };
  let hidden = [];
  let Basic = null;
  o.scene.traverse((x) => {
    if (!Basic && x.material?.type === 'MeshBasicMaterial') Basic = x.material.constructor;
  });
  const basic = new Basic({ color: 0x808080 });
  const samples = async (n) => {
    await frame();
    await frame();
    if (rt && rt.samples !== n) {
      rt.samples = n;
      r.properties.remove(rt);
    }
  };
  window.__ab = {
    msaa0: { on: () => samples(0), off: () => samples(4), settle: 600 },
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
    noShadows: {
      on: () => {
        r.shadowMap.enabled = false;
        recompile();
      },
      off: () => {
        r.shadowMap.enabled = true;
        recompile();
        r.shadowMap.needsUpdate = true;
      },
      settle: 2500,
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
  return Object.keys(window.__ab);
})();
