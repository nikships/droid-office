// Where a VR frame goes: CPU time of the session update, of render(), and the frame rate when
// each is removed; also the draw calls, and the rate with the office group (batched) hidden.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const vr = o.vr;
  async function measure(n = 60) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 7000);
    });
    t.sort((a, b) => a - b);
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const settle = () => new Promise((d) => setTimeout(d, 600));
  const out = {};
  const R = r.render,
    U = vr.update;
  let rt = 0,
    rn = 0,
    ut = 0,
    un = 0,
    calls = 0;
  r.render = function (a, b) {
    const t0 = performance.now();
    R.call(this, a, b);
    rt += performance.now() - t0;
    rn++;
    calls = r.info.render.calls;
  };
  vr.update = function (...a) {
    const t0 = performance.now();
    const x = U.apply(this, a);
    ut += performance.now() - t0;
    un++;
    return x;
  };
  out.fps = await measure();
  out.renderMs = +(rt / rn).toFixed(2);
  out.updateMs = +(ut / un).toFixed(2);
  out.calls = calls;
  vr.update = U;
  r.render = R;
  // The frame without the office drawing (merged meshes + everything else in the root).
  const g = o.scene.getObjectByName('vr-static-batches');
  const gv = g?.visible;
  if (g) g.visible = false;
  await settle();
  out.fpsNoBatches = await measure();
  if (g) g.visible = gv;
  const og = o.office.group.visible;
  o.office.group.visible = false;
  if (g) g.visible = false;
  await settle();
  out.fpsNoOffice = await measure();
  o.office.group.visible = og;
  if (g) g.visible = true;
  await settle();
  // Everything visible, but picking skipped.
  const pf = vr.hooks.pickFromRay;
  vr.hooks.pickFromRay = () => null;
  await settle();
  out.fpsNoPick = await measure();
  vr.hooks.pickFromRay = pf;
  return out;
})();
