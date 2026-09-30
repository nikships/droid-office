// CPU-side costs as abx.js toggles (visual correctness not the point):
//  skyArraysOnce: the sky's array uniforms stop re-uploading on every material switch
//  noHover: the controller rays skip picking
//  noBatchCheck: the batcher's per-frame source check is skipped
//  noAutoMatrix: scene.matrixWorldAutoUpdate off (the office's matrices freeze)
(() => {
  const o = window.__office;
  const r = o.renderer;
  let U = null;
  o.scene.traverse((x) => {
    if (!U && x.material?.type === 'MeshToonMaterial') U = r.properties.get(x.material).uniforms;
  });
  const arrays = ['skyLamps', 'skyLampColors', 'skyScreens', 'skyScreenDirs', 'skyScreenColors'].map((k) => U[k]);
  const vr = o.vr;
  const b = vr.batcher;
  const C = (window.__bcheck ??= Object.getPrototypeOf(b).check);
  const H = (window.__hover ??= Object.getPrototypeOf(vr).updateHover);
  window.__ab = {
    skyArraysOnce: {
      on: () => {
        for (const u of arrays) u.needsUpdate = false;
      },
      off: () => {
        for (const u of arrays) delete u.needsUpdate;
      },
    },
    noHover: H
      ? {
          on: () => {
            vr.updateHover = () => {};
          },
          off: () => {
            delete vr.updateHover;
          },
        }
      : undefined,
    noBatchCheck: {
      on: () => {
        b.check = () => false;
      },
      off: () => {
        delete b.check;
      },
    },
    noAutoMatrix: {
      on: () => {
        o.scene.matrixWorldAutoUpdate = false;
      },
      off: () => {
        o.scene.matrixWorldAutoUpdate = true;
      },
    },
  };
  for (const k of Object.keys(window.__ab)) if (!window.__ab[k]) delete window.__ab[k];
  void C;
  return { toggles: Object.keys(window.__ab), arrays: arrays.map((u) => u.value.length) };
})();
