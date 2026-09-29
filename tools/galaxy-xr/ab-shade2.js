// What's left of the lit shaders' cost, now the lamp loop skips indoors.
(() => {
  const o = window.__office;
  let M = null;
  o.scene.traverse((x) => {
    if (!M && x.material && !Array.isArray(x.material)) M = x.material;
  });
  let proto = Object.getPrototypeOf(M);
  while (proto && !Object.hasOwn(proto, 'onBeforeCompile')) proto = Object.getPrototypeOf(proto);
  const orig = (window.__origOBC2 ??= proto.onBeforeCompile);
  const mats = () => {
    const set = new Set();
    o.scene.traverse((x) => {
      for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) set.add(m);
    });
    return set;
  };
  const use = (fn) => {
    proto.onBeforeCompile = fn;
    for (const m of mats()) if (!Object.hasOwn(m, 'onBeforeCompile')) m.needsUpdate = true;
  };
  const noScreens = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace('+ skyScreensAt( vSkyWorld, skyN );', ';');
  };
  const noSky = (s, r) => {
    void s;
    void r;
  };
  const noSurface = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(/material\.diffuseColor \*= 1\.0 - 0\.38[^\n]*\n[^\n]*\n/, '');
  };
  const settle = 3500;
  window.__ab = {
    noScreens: { on: () => use(noScreens), off: () => use(orig), settle },
    noSurface: { on: () => use(noSurface), off: () => use(orig), settle },
    noSkyAtAll: { on: () => use(noSky), off: () => use(orig), settle },
  };
  return Object.keys(window.__ab);
})();
