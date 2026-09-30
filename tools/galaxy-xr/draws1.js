// Draw calls and triangles in exactly one XR frame, from inside three's own render.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  window.__abThaw?.();
  await new Promise((d) => setTimeout(d, 4000));
  let calls = 0;
  let tris = 0;
  let cams = 0;
  const RBD = r.renderBufferDirect;
  const R = r.render;
  r.render = function (scene, camera) {
    // render() swaps in the XR ArrayCamera itself, so the camera passed here is the user's.
    cams = r.xr.isPresenting ? r.xr.getCamera().cameras.length : 1;
    r.renderBufferDirect = function (cam, sc, geo, mat, obj, group) {
      calls++;
      const n = group ? group.count : geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
      tris += (n / 3) * (obj.isInstancedMesh ? obj.count : 1);
      return RBD.call(this, cam, sc, geo, mat, obj, group);
    };
    try {
      return R.call(this, scene, camera);
    } finally {
      r.renderBufferDirect = RBD;
      r.render = R;
    }
  };
  await new Promise((d) => s.requestAnimationFrame(d));
  await new Promise((d) => s.requestAnimationFrame(d));
  return { eyes: cams, drawsPerFrame: calls, drawsPerEye: calls / cams, ktrisPerEye: +(tris / cams / 1000).toFixed(1), infoCalls: r.info.render.calls };
})();
