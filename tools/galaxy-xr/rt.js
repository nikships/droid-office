(async () => {
  const o = window.__office;
  const r = o.renderer;
  if (!o.vr.active) await o.vr.enter();
  await new Promise((d) => setTimeout(d, 3000));
  const s = r.xr.getSession();
  let rt = null;
  const R = r.render;
  r.render = function (a, b) {
    rt = r.getRenderTarget();
    return R.call(this, a, b);
  };
  await new Promise((d) => s.requestAnimationFrame(() => s.requestAnimationFrame(d)));
  r.render = R;
  const p = r.properties.get(rt);
  const gl = r.getContext();
  let blits = 0,
    invalidates = 0;
  const B = gl.blitFramebuffer.bind(gl);
  gl.blitFramebuffer = (...a) => {
    blits++;
    return B(...a);
  };
  const I = gl.invalidateFramebuffer.bind(gl);
  gl.invalidateFramebuffer = (...a) => {
    invalidates++;
    return I(...a);
  };
  await new Promise((d) => s.requestAnimationFrame(() => s.requestAnimationFrame(d)));
  gl.blitFramebuffer = B;
  gl.invalidateFramebuffer = I;
  return {
    isXR: rt?.isXRRenderTarget,
    samples: rt?.samples,
    size: `${rt?.width}x${rt?.height}`,
    useRTT: p.__useRenderToTexture,
    hasMSFB: !!p.__webglMultisampledFramebuffer,
    depthTex: !!rt?.depthTexture,
    resolveDepth: rt?.resolveDepthBuffer,
    storeMSDepth: rt?.storeMultisampledDepthBuffer,
    blitsPerFrame: blits / 2,
    invalidatesPerFrame: invalidates / 2,
    ignoreDepth: r.xr.getBaseLayer()?.ignoreDepthValues,
  };
})();
