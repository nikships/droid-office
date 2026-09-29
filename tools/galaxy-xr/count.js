// Objects per top-level group, how many update their matrix each frame, and how many a ray visits.
(() => {
  const o = window.__office;
  const rows = [];
  for (const top of o.scene.children) {
    let n = 0,
      auto = 0,
      meshes = 0,
      shown = 0;
    top.traverse((x) => {
      n++;
      if (x.matrixAutoUpdate) auto++;
      if (x.isMesh) meshes++;
    });
    top.traverseVisible(() => shown++);
    rows.push([top.name || top.type, n, auto, meshes, shown, top.visible]);
  }
  let officeMeshes = 0,
    officeVisible = 0,
    onPickLayers = 0;
  const rc = o.vr.raycaster;
  o.office.group.traverse((x) => {
    if (x.isMesh) {
      officeMeshes++;
      if (rc && x.layers.test(rc.layers)) onPickLayers++;
    }
  });
  o.office.group.traverseVisible((x) => {
    if (x.isMesh) officeVisible++;
  });
  return { rows: rows.sort((a, b) => b[1] - a[1]), officeMeshes, officeVisible, onPickLayers, rcLayers: rc?.layers.mask };
})();
