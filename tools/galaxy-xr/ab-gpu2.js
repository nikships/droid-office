// GPU-time levers, second set: labels (and why), transparents, outside parts, shading, fill rate.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const b = o.vr.batcher;
  if (b.__frozen) {
    b.check = b.__check;
    delete b.__frozen;
  }
  const vis = (x) => {
    for (let q = x; q; q = q.parent) if (!q.visible) return false;
    return x.layers.isEnabled(0);
  };
  const labels = [];
  const lrz = new Set();
  const transp = [];
  o.scene.traverse((x) => {
    const m = x.material;
    if (!m || Array.isArray(m) || !vis(x)) return;
    if (m.transparent && m.depthWrite && m.map && x.geometry?.type === 'PlaneGeometry') labels.push(x);
    if (m.transparent) transp.push(x);
    if (m.depthWrite && m.transparent) lrz.add(m);
  });
  const hide = (list) => ({
    on: () => {
      for (const x of list) x.visible = false;
    },
    off: () => {
      for (const x of list) x.visible = true;
    },
  });
  const noDW = {
    on: () => {
      for (const m of lrz) m.depthWrite = false;
    },
    off: () => {
      for (const m of lrz) m.depthWrite = true;
    },
  };
  // Hiding whole parts changes what the batcher merges: reset it both ways and wait out the rebuild.
  const part = (list) => ({
    on: () => {
      for (const x of list) x.visible = false;
      b.reset();
    },
    off: () => {
      for (const x of list) x.visible = true;
      b.reset();
    },
    settle: 4500,
  });
  let ground = null,
    tower = null,
    clouds = null;
  for (const c of o.office.group.children) {
    let n = 0,
      far = 0,
      cloudy = false,
      _towerish = false;
    c.traverse((x) => {
      if (x.isMesh) {
        n++;
        far = Math.max(far, Math.hypot(x.matrixWorld.elements[12], x.matrixWorld.elements[14]));
        if (x.material === o.office.night.clouds) cloudy = true;
      }
    });
    if (n > 60 && far > 40) ground = c;
    if (cloudy && n < 5) clouds = c;
  }
  tower = o.office.group.children.find(
    (c) =>
      c.children.some((k) => k.children?.length && k.name === '') &&
      c !== ground &&
      c !== clouds &&
      (() => {
        let hi = 0;
        c.traverse((x) => {
          if (x.isMesh) hi = Math.max(hi, x.matrixWorld.elements[13]);
        });
        return hi > 20;
      })(),
  );
  let Basic = null;
  o.scene.traverse((x) => {
    if (!Basic && x.material?.type === 'MeshBasicMaterial') Basic = x.material.constructor;
  });
  const basic = new Basic({ color: 0x808080 });
  const V = (window.__glViewport ??= gl.viewport);
  const half = function (x, y, w, h) {
    return V.call(this, x / 2, y / 2, Math.max(1, w / 2), Math.max(1, h / 2));
  };
  window.__ab = {
    labelsNoDepthWrite: noDW,
    noLabels: hide(labels),
    noTransparent: hide(transp),
    noStreet: part([ground]),
    noTower: part([tower]),
    noOutside: part([ground, tower, clouds]),
    basicAll: {
      on: () => {
        o.scene.overrideMaterial = basic;
      },
      off: () => {
        o.scene.overrideMaterial = null;
      },
      settle: 2500,
    },
    quarterPixels: {
      on: () => {
        gl.viewport = half;
      },
      off: () => {
        gl.viewport = V;
      },
    },
  };
  if (window.__abPick) window.__ab = Object.fromEntries(window.__abPick.map((k) => [k, window.__ab[k]]));
  return Object.keys(window.__ab);
})();
