(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 90) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 8000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  let renders = 0;
  const R = r.render;
  r.render = function (a, b) {
    R.call(this, a, b);
    renders++;
  };
  let U = null;
  o.scene.traverse((x) => {
    if (!U && x.material?.type === 'MeshToonMaterial') U = r.properties.get(x.material).uniforms;
  });
  const out = { base: await measure(), lamps: U.skyLampCount.value, screens: U.skyScreenCount.value };
  // The sky's per-pixel loops pinned off each frame (sky.ts rewrites them every frame).
  let pin = true;
  const hold = () => {
    if (!pin) return;
    U.skyLampCount.value = 0;
    U.skyScreenCount.value = 0;
    s.requestAnimationFrame(hold);
  };
  s.requestAnimationFrame(hold);
  await wait(800);
  renders = 0;
  out.noLampLoops = await measure();
  out.renders1 = renders;
  pin = false;
  await wait(800);
  // Cheapest shading everywhere: same geometry and draw calls.
  let Basic;
  o.scene.traverse((x) => {
    if (!Basic && x.material?.type === 'MeshBasicMaterial') Basic = x.material.constructor;
  });
  o.scene.overrideMaterial = new Basic({ color: 0x808080 });
  await wait(1500);
  renders = 0;
  out.basicOverride = await measure();
  out.renders2 = renders;
  o.scene.overrideMaterial = null;
  await wait(1500);
  out.back = await measure();
  r.render = R;
  return out;
})();
