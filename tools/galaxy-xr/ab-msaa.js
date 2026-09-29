// Toggles for abx.js: XR MSAA off (samples 0, draws straight into the layer texture), and
// with MSAA on, invalidating the multisampled color after the resolve (saves the tile store).
(() => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  let rt = null;
  const R = r.render;
  r.render = function (a, b) {
    rt = r.getRenderTarget();
    r.render = R;
    return R.call(this, a, b);
  };
  const grab = () => new Promise((d) => s.requestAnimationFrame(() => s.requestAnimationFrame(d)));
  const _gl = r.getContext();
  const setSamples = async (n) => {
    await grab();
    if (!rt || rt.samples === n) return;
    // Force three to rebuild the target's GL objects with the new sample count.
    r.properties.remove(rt);
    rt.samples = n;
    for (const t of rt.textures) r.properties.remove(t);
    if (rt.depthTexture) r.properties.remove(rt.depthTexture);
  };
  window.__ab = {
    msaaOff: { on: () => setSamples(0), off: () => setSamples(4), settle: 800 },
  };
  return 'ok';
})();
