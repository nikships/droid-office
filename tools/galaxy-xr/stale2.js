(async () => {
  const o = window.__office;
  const s = o.renderer.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  const mats = new Map();
  o.scene.traverse((x) => {
    const ms = Array.isArray(x.material) ? x.material : x.material ? [x.material] : [];
    for (const m of ms) {
      if (!mats.has(m)) mats.set(m, { v: m.version, users: [] });
      const u = mats.get(m).users;
      if (u.length < 3) {
        const path = [];
        for (let p = x; p && path.length < 5; p = p.parent) path.push(p.name || p.type);
        u.push(path.join('<'));
      }
    }
  });
  const stacks = {};
  for (const m of mats.keys()) {
    let v = m.version;
    Object.defineProperty(m, 'version', {
      configurable: true,
      get: () => v,
      set: (n) => {
        v = n;
        const st = new Error().stack
          .split('\n')
          .slice(2, 6)
          .map((l) => l.trim().replace(/https:\/\/[^)]+\/assets\//, ''))
          .join(' | ');
        stacks[st] = (stacks[st] ?? 0) + 1;
      },
    });
  }
  for (let i = 0; i < 5; i++) await f();
  const out = [];
  for (const [m, { v, users }] of mats) if (m.version !== v) out.push({ type: m.type, name: m.name, bumps: m.version - v, users, transparent: m.transparent, map: !!m.map });
  for (const m of mats.keys()) {
    const v = m.version;
    delete m.version;
    m.version = v;
  }
  return {
    out,
    stacks: Object.entries(stacks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  };
})();
