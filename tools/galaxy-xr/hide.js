// fps with each top-level scene child (and the biggest office children) hidden, one at a time.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
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
  const label = (x) => {
    let n = 0,
      tr = 0;
    x.traverse((c) => {
      if (c.isMesh || c.isPoints || c.isSprite || c.isLine) {
        n++;
        if (c.material?.transparent) tr++;
      }
    });
    return `${x.name || x.type}#${x.id} (${n} draws, ${tr} transparent)`;
  };
  const out = { base: await measure() };
  const tryHide = async (x, key) => {
    if (!x.visible) return;
    x.visible = false;
    await wait(300);
    out[key] = await measure();
    x.visible = true;
    await wait(200);
  };
  for (const c of o.scene.children) await tryHide(c, `scene:${label(c)}`);
  const kids = [...o.office.group.children]
    .map((c) => {
      let n = 0;
      c.traverse((x) => {
        if (x.isMesh) n++;
      });
      return [c, n];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  for (const [c] of kids) await tryHide(c, `office:${label(c)}`);
  // Only transparent meshes hidden.
  const tr = [];
  o.scene.traverse((x) => {
    if (x.visible && x.material && !Array.isArray(x.material) && x.material.transparent) {
      tr.push(x);
      x.visible = false;
    }
  });
  await wait(300);
  out.noTransparent = await measure();
  for (const x of tr) x.visible = true;
  return out;
})();
