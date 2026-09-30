(async () => {
  const o = window.__office;
  const s = o.renderer.xr.getSession();
  const vr = o.vr;
  async function measure(n = 90) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 8000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const pf = vr.hooks.pickFromRay;
  let n = 0,
    ms = 0;
  vr.hooks.pickFromRay = (...a) => {
    const t0 = performance.now();
    const r = pf(...a);
    ms += performance.now() - t0;
    n++;
    return r;
  };
  const out = { base: await measure() };
  out.pickMsEach = +(ms / n).toFixed(2);
  out.picksPerFrame = +(n / 90).toFixed(2);
  vr.hooks.pickFromRay = () => null;
  await wait(500);
  out.noPick = await measure();
  vr.hooks.pickFromRay = pf;
  await wait(500);
  out.back = await measure();
  return out;
})();
