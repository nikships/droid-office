// XRWebGLLayer (Chrome's own framebuffer, antialias from the context) vs three's projection layer
// path (explicit 4x MSAA renderbuffer + blit). Each arm restarts the session.
(() => {
  const o = window.__office;
  const P = XRWebGLBinding.prototype;
  const desc = (window.__cplDesc ??= Object.getOwnPropertyDescriptor(P, 'createProjectionLayer'));
  const restart = async (webgl) => {
    const s = o.renderer.xr.getSession();
    if (s) {
      await s.end();
      await new Promise((d) => setTimeout(d, 800));
    }
    if (webgl) delete P.createProjectionLayer;
    else if (!Object.hasOwn(P, 'createProjectionLayer')) Object.defineProperty(P, 'createProjectionLayer', desc);
    await o.vr.enter();
    await new Promise((d) => setTimeout(d, 1500));
    o.vr.ui?.controls?.hide?.();
    const n = o.renderer.xr.getSession();
    const l = n.renderState.baseLayer ?? n.renderState.layers?.at(-1);
    window.__baseInfo = { kind: l?.constructor.name, antialias: l?.antialias, fbw: l?.framebufferWidth, fbh: l?.framebufferHeight, texw: l?.textureWidth };
  };
  window.__ab = { webglLayer: { on: () => restart(true), off: () => restart(false), settle: 2500 } };
  return Object.keys(window.__ab);
})();
