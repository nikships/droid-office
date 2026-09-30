// GL uploads per XR frame: texture uploads, mipmap generations, buffer uploads, and which textures change.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const s = r.xr.getSession();
  const frame = () => new Promise((d) => s.requestAnimationFrame(d));
  const n = { texImage2D: 0, texSubImage2D: 0, generateMipmap: 0, bufferData: 0, bufferSubData: 0, texStorage2D: 0, texImage3D: 0 };
  const orig = {};
  for (const k of Object.keys(n)) {
    orig[k] = gl[k];
    gl[k] = function (...a) {
      n[k]++;
      return orig[k].apply(this, a);
    };
  }
  const texs = new Map();
  o.scene.traverse((x) => {
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) for (const t of [m.map, m.emissiveMap, m.alphaMap]) if (t) texs.set(t, t.version);
  });
  await frame();
  for (const k of Object.keys(n)) n[k] = 0;
  const F = 60;
  for (let i = 0; i < F; i++) await frame();
  for (const k of Object.keys(n)) gl[k] = orig[k];
  const changed = [];
  for (const [t, v] of texs) if (t.version !== v) changed.push(`${t.image?.width}x${t.image?.height} +${t.version - v} ${t.name || t.constructor.name}`);
  return { perFrame: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, +(v / F).toFixed(2)])), changedIn60: changed };
})();
