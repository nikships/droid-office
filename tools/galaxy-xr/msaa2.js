(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const gl = r.getContext();
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  const measure = async (n = 60) => {
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
  };
  let rt = null;
  const R = r.render;
  r.render = function (a, b) {
    rt = r.getRenderTarget();
    return R.call(this, a, b);
  };
  await frame();
  await frame();
  r.render = R;
  const blitsNow = async () => {
    let n = 0;
    const B = gl.blitFramebuffer;
    gl.blitFramebuffer = function (...a) {
      n++;
      return B.apply(this, a);
    };
    for (let i = 0; i < 10; i++) await frame();
    gl.blitFramebuffer = B;
    return n / 10;
  };
  const out = { before: { samples: rt.samples, blits: await blitsNow(), fps: await measure() } };
  // three keeps the XR target's GL objects in properties; drop them so the next setRenderTarget
  // rebuilds the target single-sampled on the layer's own texture.
  const p = r.properties.get(rt);
  out.keys = Object.keys(p);
  rt.samples = 0;
  r.properties.remove(rt);
  await frame();
  await frame();
  out.after = { samples: rt.samples, blits: await blitsNow(), fps: await measure(), keys: Object.keys(r.properties.get(rt)) };
  return out;
})();
