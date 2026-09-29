// Transparent objects bucketed by what they are (type + blending + depthWrite + side), as abx.js toggles.
(() => {
  const o = window.__office;
  const buckets = new Map();
  o.scene.traverse((x) => {
    if (!x.visible || !x.material || Array.isArray(x.material) || !x.material.transparent) return;
    for (let p = x.parent; p; p = p.parent) if (!p.visible) return;
    const m = x.material;
    const k = `${x.type}/${m.type} blend=${m.blending} dw=${m.depthWrite} side=${m.side} op=${m.opacity.toFixed(2)}${m.map ? ' map' : ''} ${x.geometry?.type ?? ''}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  });
  const list = [...buckets].sort((a, b) => b[1].length - a[1].length);
  window.__ab = {};
  for (const [k, xs] of list.slice(0, 9))
    window.__ab[`${xs.length}x ${k}`] = {
      on: () => {
        for (const x of xs) x.visible = false;
      },
      off: () => {
        for (const x of xs) x.visible = true;
      },
    };
  const rest = list.slice(9).flatMap(([, xs]) => xs);
  window.__ab[`rest ${rest.length}`] = {
    on: () => {
      for (const x of rest) x.visible = false;
    },
    off: () => {
      for (const x of rest) x.visible = true;
    },
  };
  return list.map(([k, xs]) => `${xs.length}x ${k}`);
})();
