(async () => {
  const o = window.__office;
  const r = o.renderer;
  const xr = r.xr;
  const s = xr.getSession?.();
  const out = { vrActive: o.vr?.active, presenting: xr.isPresenting, dpr: devicePixelRatio, canvas: [r.domElement.width, r.domElement.height] };
  if (s) {
    out.session = {
      visibility: s.visibilityState,
      frameRate: s.frameRate,
      supportedFrameRates: s.supportedFrameRates ? [...s.supportedFrameRates] : null,
      enabledFeatures: s.enabledFeatures,
      inputSources: [...s.inputSources].map((i) => ({ hand: i.handedness, profiles: i.profiles, isHand: !!i.hand })),
    };
    const layer = s.renderState.baseLayer;
    if (layer) out.baseLayer = { fbW: layer.framebufferWidth, fbH: layer.framebufferHeight, antialias: layer.antialias, fixedFoveation: layer.fixedFoveation };
    out.renderStateLayers = s.renderState.layers?.length;
    out.nativeScale = globalThis.XRWebGLLayer?.getNativeFramebufferScaleFactor?.(s);
    // Frame timing through the XR session's own rAF.
    const times = [];
    let last = 0;
    await new Promise((done) => {
      const step = (t) => {
        if (last) times.push(t - last);
        last = t;
        if (times.length < 180) s.requestAnimationFrame(step);
        else done();
      };
      s.requestAnimationFrame(step);
      setTimeout(done, 6000);
    });
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    out.frames = { n: times.length, avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(1), p50: +times[times.length >> 1]?.toFixed(2), p95: +times[Math.floor(times.length * 0.95)]?.toFixed(2), max: +times[times.length - 1]?.toFixed(2) };
  }
  // CPU cost of our frame() body: time spent in renderer.render calls vs whole callback.
  const info = r.info;
  out.info = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length };
  out.autoReset = info.autoReset;
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  out.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  out.fpsEl = document.getElementById('fps')?.textContent;
  return out;
})();
