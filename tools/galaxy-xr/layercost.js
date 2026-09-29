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
      setTimeout(d, 6000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const ui = vr.ui;
  const out = {};
  ui.showControls();
  await wait(1500);
  out.cardLayered = await measure();
  out.layers = s.renderState.layers.length;
  const upd = vr.layers.update;
  vr.layers.update = () => {};
  vr.layers.clear();
  await wait(1500);
  out.cardMesh = await measure();
  out.layers2 = s.renderState.layers.length;
  vr.layers.update = upd;
  ui.controls.hide();
  await wait(1500);
  out.cardHidden = await measure();
  out.layers3 = s.renderState.layers.length;
  return out;
})();
