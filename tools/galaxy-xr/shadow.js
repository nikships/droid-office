(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  let sm = 0,
    _smCalls = 0;
  const SR = r.shadowMap.render;
  r.shadowMap.render = function (...a) {
    const c0 = r.info.render.calls;
    SR.apply(this, a);
    if (r.shadowMap.needsUpdate !== undefined) {
    }
    sm++;
    _smCalls += r.info.render.calls - c0;
  };
  const ups = [];
  let flag = r.shadowMap.needsUpdate;
  Object.defineProperty(r.shadowMap, 'needsUpdate', {
    configurable: true,
    get: () => flag,
    set: (v) => {
      if (v)
        ups.push(
          new Error().stack
            .split('\n')
            .slice(2, 4)
            .map((l) => l.trim().replace(/https:\/\/[^)]+\/assets\//, ''))
            .join(' | '),
        );
      flag = v;
    },
  });
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  for (let i = 0; i < 30; i++) await f();
  r.shadowMap.render = SR;
  delete r.shadowMap.needsUpdate;
  r.shadowMap.needsUpdate = flag;
  const byStack = {};
  for (const u of ups) byStack[u] = (byStack[u] ?? 0) + 1;
  return { frames: 30, shadowRenders: sm, autoUpdate: r.shadowMap.autoUpdate, needsUpdateSets: ups.length, byStack: Object.entries(byStack).slice(0, 5) };
})();
