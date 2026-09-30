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
  vr.ui.showControls();
  await wait(1500);
  const out = { under: await measure(), n: s.renderState.layers.length };
  const upd = vr.layers.update;
  vr.layers.update = () => {};
  const L = s.renderState.layers;
  const base = L[L.length - 1];
  s.updateRenderState({ layers: [base, ...L.slice(0, -1)] });
  await wait(1500);
  out.over = await measure();
  s.updateRenderState({ layers: [base] });
  await wait(1500);
  out.none = await measure();
  s.updateRenderState({ layers: L });
  vr.layers.update = upd;
  return out;
})();
