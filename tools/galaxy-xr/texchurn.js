// Textures whose version moves across 30 XR frames (each move = a re-upload, plus mips if enabled),
// and GL upload calls per frame.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const s = r.xr.getSession();
  const texs = new Map();
  o.scene.traverse((x) => {
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) {
      for (const k of ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'gradientMap']) {
        const t = m[k];
        if (t) texs.set(t, { v: t.version, obj: x });
      }
    }
  });
  const calls = { texImage2D: 0, texSubImage2D: 0, generateMipmap: 0, texStorage2D: 0 };
  const orig = {};
  for (const k of Object.keys(calls)) {
    orig[k] = gl[k];
    gl[k] = function (...a) {
      calls[k]++;
      return orig[k].apply(this, a);
    };
  }
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  for (let i = 0; i < 30; i++) await frame();
  for (const k of Object.keys(calls)) gl[k] = orig[k];
  const moved = [];
  for (const [t, { v, obj }] of texs)
    if (t.version !== v) {
      let vis = true;
      for (let q = obj; q; q = q.parent) if (!q.visible) vis = false;
      moved.push({ bumps: t.version - v, size: t.image ? `${t.image.width}x${t.image.height}` : '?', mips: t.generateMipmaps, name: obj.name || obj.parent?.name || obj.parent?.parent?.name || '?', vis, type: t.constructor.name });
    }
  return { textures: texs.size, perFrame: Object.fromEntries(Object.entries(calls).map(([k, n]) => [k, +(n / 30).toFixed(2)])), moved };
})();
