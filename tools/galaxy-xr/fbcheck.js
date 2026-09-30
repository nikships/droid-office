// Which framebuffer the office's draws land in during one XR frame, vs the base layer's.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const s = r.xr.getSession();
  const base = r.xr.getBaseLayer();
  const layerFb = base?.framebuffer ?? null;
  const seen = new Map();
  const D = gl.drawElements,
    A = gl.drawArrays;
  const note = () => {
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const k = fb === null ? 'null(canvas)' : fb === layerFb ? 'layer' : 'other';
    seen.set(k, (seen.get(k) ?? 0) + 1);
  };
  gl.drawElements = function (...a) {
    note();
    return D.apply(this, a);
  };
  gl.drawArrays = function (...a) {
    note();
    return A.apply(this, a);
  };
  let rtInfo = null;
  const R = r.render;
  r.render = function (a, b) {
    const rt = r.getRenderTarget();
    rtInfo = rt ? { isXR: !!rt.isXRRenderTarget, w: rt.width, fb: r.properties.get(rt).__webglFramebuffer === layerFb ? 'layer' : String(r.properties.get(rt).__webglFramebuffer) } : 'none';
    return R.call(this, a, b);
  };
  await new Promise((d) => s.requestAnimationFrame(d));
  await new Promise((d) => s.requestAnimationFrame(d));
  gl.drawElements = D;
  gl.drawArrays = A;
  r.render = R;
  return {
    base: base?.constructor.name,
    layerFbNull: layerFb === null,
    draws: Object.fromEntries(seen),
    rtAtRender: rtInfo,
    renderStateLayers: s.renderState.layers?.map((l) => l.constructor.name),
    baseLayerProp: s.renderState.baseLayer?.constructor.name,
  };
})();
