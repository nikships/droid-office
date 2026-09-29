(async () => {
  const s = window.__office.renderer.xr.getSession();
  const t = [];
  let l = 0;
  await new Promise((d) => {
    const f = (x) => {
      if (l) t.push(+(x - l).toFixed(1));
      l = x;
      t.length < 60 ? s.requestAnimationFrame(f) : d();
    };
    s.requestAnimationFrame(f);
    setTimeout(d, 6000);
  });
  const h = {};
  for (const v of t) {
    const k = Math.round(v / 13.89);
    h[`${k}x`] = (h[`${k}x`] ?? 0) + 1;
  }
  return { hist: h, sample: t.slice(0, 20) };
})();
