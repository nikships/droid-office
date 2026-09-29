(() => {
  const r = window.__office.renderer;
  const gl = r.getContext();
  const xr = r.xr;
  const base = xr.getBaseLayer();
  const rt = r.getRenderTarget() ?? xr.getRenderTarget?.();
  const exts = gl.getSupportedExtensions().filter((e) => /multiview|multisample|invalidate|foveat|shading_rate|depth|float|timer/i.test(e));
  const t = rt ?? null;
  return {
    base: base?.constructor.name,
    ignoreDepthValues: base?.ignoreDepthValues,
    tex: base && [base.textureWidth, base.textureHeight, base.textureArrayLength],
    fixedFoveation: base?.fixedFoveation,
    exts,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    rt: t && { samples: t.samples, resolveDepth: t.resolveDepthBuffer, storeMSDepth: t.storeMultisampledDepthBuffer, stencil: t.stencilBuffer, w: t.width, h: t.height, depthTex: !!t.depthTexture },
    ctx: gl.getContextAttributes(),
  };
})();
