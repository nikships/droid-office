// How the drawn opaque materials differ: if most are toon materials that differ only in color,
// baking color into vertices would let them share one material.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  const f = () => new Promise((d) => s.requestAnimationFrame(d));
  const drawn = new Map();
  const RBD = r.renderBufferDirect;
  r.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    if (!mat.transparent) drawn.set(mat, (drawn.get(mat) ?? 0) + 1);
    return RBD.call(this, cam, scene, geo, mat, obj, group);
  };
  await f();
  drawn.clear();
  await f();
  r.renderBufferDirect = RBD;
  const sig = (m) =>
    [
      m.type,
      m.map ? 'map' : '',
      m.gradientMap?.uuid?.slice(0, 4) ?? '',
      m.emissive?.getHex() ? 'emis' : '',
      m.side,
      m.vertexColors ? 'vc' : '',
      m.fog ? 'fog' : '',
      m.toneMapped ? 'tm' : '',
      m.flatShading ? 'flat' : '',
      m.alphaTest,
      m.polygonOffset ? 'po' : '',
      m.depthTest ? '' : 'nodt',
      m.onBeforeCompile?.toString().length > 20 ? 'obc' : '',
      m.userData?.outlineParameters ? 'ol' : '',
    ].join('/');
  const bySig = {};
  for (const [m, n] of drawn) {
    const k = sig(m);
    bySig[k] = bySig[k] ?? { mats: 0, calls: 0 };
    bySig[k].mats++;
    bySig[k].calls += n;
  }
  return {
    materials: drawn.size,
    bySig: Object.entries(bySig)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 15),
  };
})();
