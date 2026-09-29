// GPU levers on the real path (projection layer + quads). Batcher frozen during the run.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
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
  const B = (window.__blit ??= gl.blitFramebuffer);
  const inval = function (...a) {
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
    return B.apply(this, a);
  };
  const labels = [];
  let hidden = [];
  o.scene.traverse((x) => {
    const m = x.material;
    if (m && !Array.isArray(m) && m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry') labels.push(x);
  });
  const all = {
    depthInval: {
      on: () => {
        gl.blitFramebuffer = inval;
      },
      off: () => {
        gl.blitFramebuffer = B;
      },
    },
    msaa2: { on: () => samples(2), off: () => samples(4), settle: 600 },
    msaa0: { on: () => samples(0), off: () => samples(4), settle: 600 },
    [`noLabels${labels.length}`]: {
      on: () => {
        for (const x of labels) x.visible = false;
      },
      off: () => {
        for (const x of labels) x.visible = true;
      },
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
  };
  const pick = window.__abPick;
  window.__ab = pick ? Object.fromEntries(pick.map((k) => [k, all[k] ?? Object.entries(all).find(([n]) => n.startsWith(k))?.[1]])) : all;
  window.__abThaw = () => {
    if (b.__frozen) {
      b.check = b.__check;
      delete b.__frozen;
    }
  };
  return Object.keys(window.__ab);
})();
