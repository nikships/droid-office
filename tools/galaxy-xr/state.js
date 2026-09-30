(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  await f();
  r.info.reset();
  await f();
  const calls = r.info.render.calls;
  return { calls, batches: o.vr.batcher?.meshes, saved: o.vr.batcher?.saved, layers: s.renderState.layers.map((l) => l.constructor.name) };
})();
