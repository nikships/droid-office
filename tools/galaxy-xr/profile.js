(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const gl = r.getContext();
  const out = {};
  const pl = r.xr.getBaseLayer?.();
  if (pl) out.layer = { type: pl.constructor.name, textureWidth: pl.textureWidth, textureHeight: pl.textureHeight, fixedFoveation: pl.fixedFoveation, fbW: pl.framebufferWidth, fbH: pl.framebufferHeight };
  out.glDrawingBuffer = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  out.xrCamSubcams = r.xr.getCamera().cameras.length;

  // CPU time: how long renderer.render takes, and how long the whole XR frame callback takes.
  const origRender = r.render.bind(r);
  const renders = [];
  let calls = 0,
    tris = 0;
  r.render = (sc, cam) => {
    const t0 = performance.now();
    origRender(sc, cam);
    renders.push(performance.now() - t0);
    calls += r.info.render.calls;
    tris += r.info.render.triangles;
  };
  // GPU time via timer queries if the extension exists.
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  out.gpuTimerExt = !!ext;
  const gpu = [];
  const cb = [];
  await new Promise((done) => {
    let n = 0;
    const step = (_t, _f) => {
      const t0 = performance.now();
      let q;
      if (ext) {
        q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      }
      // Measured on the next tick: three's own XR callback runs in the same frame.
      setTimeout(() => {
        cb.push(performance.now() - t0);
      }, 0);
      if (ext) {
        queueMicrotask(() => {});
        setTimeout(() => {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          const poll = () => {
            if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
              if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
              gl.deleteQuery(q);
            } else setTimeout(poll, 5);
          };
          poll();
        }, 0);
      }
      if (++n < 90) s.requestAnimationFrame(step);
      else setTimeout(done, 300);
    };
    s.requestAnimationFrame(step);
  });
  r.render = origRender;
  const stat = (a) => {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y);
    return { n: b.length, avg: +(b.reduce((x, y) => x + y, 0) / b.length).toFixed(2), p50: +b[b.length >> 1].toFixed(2), p95: +b[Math.floor(b.length * 0.95)].toFixed(2) };
  };
  out.renderCpuMs = stat(renders);
  out.rendersPerFrame = +(renders.length / 90).toFixed(2);
  out.drawCallsPerRender = Math.round(calls / Math.max(1, renders.length));
  out.trisPerRender = Math.round(tris / Math.max(1, renders.length));
  out.xrCallbackToIdleMs = stat(cb);
  out.gpuMs = stat(gpu);

  // Scene makeup.
  let meshes = 0,
    visible = 0,
    lights = 0,
    shadowLights = 0,
    transparent = 0,
    instanced = 0;
  o.scene.traverse((x) => {
    if (x.isLight) {
      lights++;
      if (x.castShadow) shadowLights++;
    }
    if (x.isMesh) {
      meshes++;
      if (x.visible) visible++;
      if (x.material?.transparent) transparent++;
      if (x.isInstancedMesh) instanced++;
    }
  });
  out.scene = { meshes, visibleMeshes: visible, transparent, instanced, lights, shadowLights, shadowMap: r.shadowMap.enabled, shadowType: r.shadowMap.type, toneMapping: r.toneMapping, pixelRatio: r.getPixelRatio() };
  return out;
})();
