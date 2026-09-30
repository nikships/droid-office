// One toggle per transparent material (biggest groups), for abx.js.
(() => {
  const o = window.__office;
  const byMat = new Map();
  o.scene.traverse((x) => {
    if (!x.visible || !(x.isMesh || x.isPoints || x.isSprite) || Array.isArray(x.material) || !x.material.transparent) return;
    const m = x.material;
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(x);
  });
  const V = o.camera.position.constructor;
  const area = (list) => {
    let a = 0;
    for (const x of list) {
      if (!x.geometry.boundingBox) x.geometry.computeBoundingBox();
      const s = x.geometry.boundingBox.getSize(new V()).multiply(x.getWorldScale(new V()));
      const d = [s.x, s.y, s.z].sort((p, q) => q - p);
      a += d[0] * d[1];
    }
    return a.toFixed(0);
  };
  const groups = [...byMat]
    .map(([m, list]) => [m, list, +area(list)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, 7);
  window.__ab = {};
  for (const [m, list, a] of groups) {
    const path = [];
    for (let p = list[0]; p && path.length < 4; p = p.parent) path.push(p.name || p.type);
    window.__ab[`${list.length}x ${m.type} op=${m.opacity.toFixed(2)} blend=${m.blending} area=${a}m2 ${m.map ? 'map ' : ''}${path.join('<')}`] = {
      on: () => {
        for (const x of list) x.visible = false;
      },
      off: () => {
        for (const x of list) x.visible = true;
      },
    };
  }
  return Object.keys(window.__ab);
})();
