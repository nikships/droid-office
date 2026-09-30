// What cutting each part of the scene would buy. Hiding a part changes what the batcher merges, so
// every flip resets the batcher and waits out its watch window (1.5 s) and the rebuild.
(() => {
  const o = window.__office;
  const _r = o.renderer;
  const b = o.vr.batcher;
  if (b.__frozen) {
    b.check = b.__check;
    delete b.__frozen;
  }
  const kids = o.office.group.children;
  const bounds = (c) => {
    let minY = Infinity,
      maxY = -Infinity,
      far = 0;
    c.traverse((x) => {
      if (x.isMesh) {
        const p = x.getWorldPosition(x.position.clone());
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        far = Math.max(far, Math.hypot(p.x, p.z));
      }
    });
    return { minY, maxY, far };
  };
  let ground = null,
    clouds = null;
  for (const c of kids) {
    let n = 0;
    c.traverse((x) => {
      if (x.isMesh) n++;
    });
    const bb = bounds(c);
    if (n > 60 && bb.far > 40) ground = c;
    let cloudy = false;
    c.traverse((x) => {
      if (x.material === o.office.night.clouds) cloudy = true;
    });
    if (cloudy && n < 5) clouds = c;
  }
  const flip = (list, on) => {
    for (const x of list) {
      x.__v ??= x.visible;
      x.visible = on ? false : x.__v;
    }
    b.reset();
  };
  const arm = (list) => ({ on: () => flip(list, true), off: () => flip(list, false), settle: 4000 });
  let Basic = null;
  o.scene.traverse((x) => {
    if (!Basic && x.material?.type === 'MeshBasicMaterial') Basic = x.material.constructor;
  });
  const basic = new Basic({ color: 0x808080 });
  const all = {
    noStreet: arm([ground]),
    noClouds: arm([clouds]),
    noOutside: arm([ground, clouds]),
    basicAll: {
      on: () => {
        o.scene.overrideMaterial = basic;
      },
      off: () => {
        o.scene.overrideMaterial = null;
      },
      settle: 2500,
    },
  };
  const pick = window.__abPick;
  window.__ab = pick ? Object.fromEntries(pick.map((k) => [k, all[k]])) : all;
  return { ground: !!ground, clouds: !!clouds, arms: Object.keys(window.__ab) };
})();
