// Splits a VR hover pick: full intersect, tree walk only (every raycast a no-op), and how many
// objects and meshes the walk visits. Also times one scene.updateMatrixWorld.
(() => {
  const o = window.__office;
  const vr = o.vr;
  const rc = vr.raycaster;
  const THREE_Mesh = o.office.group.getObjectByProperty('isMesh', true).constructor;
  let Base = THREE_Mesh;
  while (Base && !Object.hasOwn(Base.prototype, 'raycast')) Base = Object.getPrototypeOf(Base);
  const root = o.office.group;
  const time = (f, n = 40) => {
    f();
    const t = performance.now();
    for (let i = 0; i < n; i++) f();
    return +((performance.now() - t) / n).toFixed(3);
  };
  const cam = o.camera;
  const dir = cam.getWorldDirection(new cam.position.constructor());
  const from = cam.getWorldPosition(new cam.position.constructor());
  rc.set(from, dir);
  rc.far = 12;
  rc.camera = cam;
  const full = time(() => rc.intersectObject(root, true));
  let visits = 0,
    meshes = 0;
  const saved = new Map();
  root.traverse((x) => {
    saved.set(x, Object.hasOwn(x, 'raycast') ? x.raycast : undefined);
    x.raycast = function () {
      visits++;
      if (this.isMesh) meshes++;
    };
  });
  const walk = time(() => rc.intersectObject(root, true));
  visits = 0;
  meshes = 0;
  rc.intersectObject(root, true);
  for (const [x, f] of saved) {
    if (f === undefined) delete x.raycast;
    else x.raycast = f;
  }
  const mat = time(() => o.scene.updateMatrixWorld(), 20);
  let auto = 0;
  o.scene.traverse((x) => {
    if (x.matrixAutoUpdate) auto++;
  });
  return { fullMs: full, walkOnlyMs: walk, visits, meshes, updateMatrixWorldMs: mat, autoNodes: auto };
})();
