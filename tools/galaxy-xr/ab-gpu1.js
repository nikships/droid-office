// The GPU levers, on one harness: MSAA, labels, transparents, the street, the shading model.
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
  const samples = async (n) => {
    await frame();
    await frame();
    if (rt && rt.samples !== n) {
      rt.samples = n;
      r.properties.remove(rt);
    }
  };
  const vis = (x) => {
    for (let q = x; q; q = q.parent) if (!q.visible) return false;
    return x.layers.isEnabled(0);
  };
  const labels = [];
  const transp = [];
  o.scene.traverse((x) => {
    const m = x.material;
    if (!m || Array.isArray(m) || !vis(x)) return;
    if (m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry') labels.push(x);
    if (m.transparent) transp.push(x);
  });
  const hide = (list) => ({
    on: () => {
      for (const x of list) x.visible = false;
    },
    off: () => {
      for (const x of list) x.visible = true;
    },
  });
  let Basic = null;
  o.scene.traverse((x) => {
    if (!Basic && x.material?.type === 'MeshBasicMaterial') Basic = x.material.constructor;
  });
  const basic = new Basic({ color: 0x808080 });
  window.__ab = {
    msaa2: { on: () => samples(2), off: () => samples(4), settle: 800 },
    msaa0: { on: () => samples(0), off: () => samples(4), settle: 800 },
    noLabels: hide(labels),
    noTransparent: hide(transp),
    basicAll: {
      on: () => {
        o.scene.overrideMaterial = basic;
      },
      off: () => {
        o.scene.overrideMaterial = null;
      },
      settle: 2500,
    },
  };
  if (window.__abPick) window.__ab = Object.fromEntries(window.__abPick.map((k) => [k, window.__ab[k]]));
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return Object.keys(window.__ab);
})();
