// fps with each of the largest merged meshes hidden, to see which cover the most screen.
(async () => {
  const o = window.__office;
  const s = o.renderer.xr.getSession();
  async function measure(n = 50) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 5000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const g = o.scene.getObjectByName('vr-static-batches');
  const V = o.camera.position.constructor;
  const list = g.children
    .map((m) => {
      m.geometry.computeBoundingBox();
      const sz = m.geometry.boundingBox.getSize(new V());
      return [m, m.geometry.attributes.position.count, sz];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const out = { base: await measure() };
  for (const [m, n, sz] of list) {
    m.visible = false;
    await wait(300);
    out[
      `${n}v ${sz
        .toArray()
        .map((v) => v.toFixed(0))
        .join('x')} ${m.material.name}`
    ] = await measure();
    m.visible = true;
  }
  // Lights off (the toon shader's cost of lighting): hemisphere+ambient+sun hidden.
  return out;
})();
