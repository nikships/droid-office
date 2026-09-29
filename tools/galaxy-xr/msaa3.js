// MSAA kept, but the multisampled attachments invalidated after three's resolve blit (what three
// only does on OculusBrowser), and depth invalidated before the blit so it never stores.
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
  if (rt.samples === 0) {
    rt.samples = 4;
    r.properties.remove(rt);
    await frame();
    await frame();
  }
  const B = gl.blitFramebuffer;
  const patch = () => {
    gl.blitFramebuffer = function (...a) {
      // Depth never needs to leave the tile: drop it before the resolve reads it.
      gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
      B.apply(this, a);
      gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
    };
  };
  const unpatch = () => {
    gl.blitFramebuffer = B;
  };
  const out = {};
  const on = [],
    off = [];
  for (let i = 0; i < 3; i++) {
    unpatch();
    await frame();
    off.push(await measure());
    patch();
    await frame();
    on.push(await measure());
  }
  unpatch();
  out.plainMSAA = off;
  out.invalidated = on;
  return out;
})();
