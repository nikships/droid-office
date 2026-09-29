// skyFlat: the sky's array uniforms hold Float32Arrays (three uploads them as they are, no per-vector
// toArray on each material switch). Values are copied once, so they go stale; fine for timing.
(() => {
  const o = window.__office;
  const r = o.renderer;
  let U = null;
  o.scene.traverse((x) => {
    if (!U && x.material?.type === 'MeshToonMaterial') U = r.properties.get(x.material).uniforms;
  });
  const keys = ['skyLamps', 'skyLampColors', 'skyScreens', 'skyScreenDirs', 'skyScreenColors'];
  window.__skyOrig ??= Object.fromEntries(keys.map((k) => [k, U[k].value]));
  const flat = Object.fromEntries(
    keys.map((k) => {
      const v = window.__skyOrig[k];
      const n = v[0].isVector4 ? 4 : 3;
      const a = new Float32Array(v.length * n);
      v.forEach((x, i) => x.toArray(a, i * n));
      return [k, a];
    }),
  );
  window.__ab = {
    skyFlat: {
      on: () => {
        for (const k of keys) U[k].value = flat[k];
      },
      off: () => {
        for (const k of keys) U[k].value = window.__skyOrig[k];
      },
    },
  };
  return Object.keys(window.__ab);
})();
