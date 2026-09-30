// GPU time of one XR frame's world render via EXT_disjoint_timer_query_webgl2, if exposed.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { timer: 'unavailable', exts: gl.getSupportedExtensions().filter((e) => /timer|multiview|fovea|shading/i.test(e)) };
  const _s = r.xr.getSession();
  const R = r.render;
  const qs = [];
  r.render = function (a, b) {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    R.call(this, a, b);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    qs.push(q);
  };
  await new Promise((d) => setTimeout(d, 1500));
  r.render = R;
  await new Promise((d) => setTimeout(d, 500));
  const ms = [];
  for (const q of qs) if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
  ms.sort((a, b) => a - b);
  return { n: ms.length, p50: ms[ms.length >> 1]?.toFixed(2), p90: ms[Math.floor(ms.length * 0.9)]?.toFixed(2), disjoint: gl.getParameter(ext.GPU_DISJOINT_EXT) };
})();
