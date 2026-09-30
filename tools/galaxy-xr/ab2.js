(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const _THREE_Mesh = o.scene.children.find((c) => c.isMesh)?.constructor;
  async function measure(n = 90) {
    const times = [];
    let last = 0;
    await new Promise((done) => {
      const step = (t) => {
        if (last) times.push(t - last);
        last = t;
        if (times.length < n) s.requestAnimationFrame(step);
        else done();
      };
      s.requestAnimationFrame(step);
      setTimeout(done, 6000);
    });
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return { fps: +(1000 / avg).toFixed(1), p50ms: +times[times.length >> 1].toFixed(1) };
  }
  const settle = () => new Promise((d) => setTimeout(d, 600));
  const out = {};
  out.api = { updateTargetFrameRate: typeof s.updateTargetFrameRate, frameRate: s.frameRate, supported: s.supportedFrameRates ? [...s.supportedFrameRates] : null };

  // Which textures re-upload every frame?
  const texs = new Map();
  o.scene.traverse((x) => {
    const m = x.material;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) for (const k of ['map', 'emissiveMap', 'alphaMap']) if (mm[k]) texs.set(mm[k], { v: mm[k].version, img: mm[k].image, obj: x });
  });
  await measure(30);
  const hot = [];
  for (const [t, e] of texs) if (t.version - e.v > 5) hot.push({ uploads30: t.version - e.v, px: e.img ? [e.img.width, e.img.height] : null, name: e.obj.name || e.obj.parent?.name || e.obj.parent?.parent?.name || '' });
  out.hotTextures = hot.sort((a, b) => b.uploads30 - a.uploads30).slice(0, 20);
  out.hotMpxPerFrame = +(hot.reduce((a, h) => a + (h.px ? h.px[0] * h.px[1] : 0) * (h.uploads30 / 30), 0) / 1e6).toFixed(2);

  // Materials in use.
  const mats = {};
  o.scene.traverse((x) => {
    if (x.isMesh && x.visible) {
      const m = Array.isArray(x.material) ? x.material[0] : x.material;
      mats[m.type] = (mats[m.type] ?? 0) + 1;
    }
  });
  out.materials = mats;

  // Fragment cost: everything flat-shaded with the same draw calls.
  const basicCtor = Object.getPrototypeOf(o.scene).constructor; // placeholder, not used
  void basicCtor;
  let MeshBasic;
  o.scene.traverse((x) => {
    if (!MeshBasic && x.material?.type === 'MeshBasicMaterial') MeshBasic = x.material.constructor;
  });
  if (MeshBasic) {
    o.scene.overrideMaterial = new MeshBasic({ color: 0x808080 });
    await settle();
    out.overrideBasic = await measure();
    o.scene.overrideMaterial = null;
    await settle();
  }

  // Freeze texture uploads: stop needsUpdate from bumping versions for a moment.
  const saved = [];
  for (const [t] of texs) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(t)), 'needsUpdate') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'needsUpdate');
    void d;
    saved.push(t);
    Object.defineProperty(t, 'needsUpdate', {
      configurable: true,
      set() {},
      get() {
        return false;
      },
    });
  }
  await settle();
  out.noTextureUploads = await measure();
  for (const t of saved) delete t.needsUpdate;
  await settle();
  out.baselineAgain = await measure();
  return out;
})();
