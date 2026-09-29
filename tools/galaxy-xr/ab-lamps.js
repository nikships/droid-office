(() => {
  const o = window.__office;
  let M = null;
  o.scene.traverse((x) => {
    if (!M && x.material && !Array.isArray(x.material)) M = x.material;
  });
  let proto = Object.getPrototypeOf(M);
  while (proto && !Object.hasOwn(proto, 'onBeforeCompile')) proto = Object.getPrototypeOf(proto);
  const orig = (window.__origOBC ??= proto.onBeforeCompile);
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
  const LIGHT = /vec3 skyLight = [^\n]*\n/;
  const indoorSkip = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(
      LIGHT,
      `vec3 skyLight = skyIndoor * skyOffice * ( 0.65 + 0.35 * skyN.y ) + skyScreensAt( vSkyWorld, skyN );
  if ( skyIndoor < 1.0 ) skyLight += ( 1.0 - skyIndoor ) * ( skyGar * skyGarage + skyLampsAt( vSkyWorld, skyN ) );
`,
    );
  };
  const noScreens = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(
      LIGHT,
      `vec3 skyLight = skyIndoor * skyOffice * ( 0.65 + 0.35 * skyN.y ) + ( 1.0 - skyIndoor ) * ( skyGar * skyGarage + skyLampsAt( vSkyWorld, skyN ) );
`,
    );
  };
  const both = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(
      LIGHT,
      `vec3 skyLight = skyIndoor * skyOffice * ( 0.65 + 0.35 * skyN.y );
  if ( skyIndoor < 1.0 ) skyLight += ( 1.0 - skyIndoor ) * ( skyGar * skyGarage + skyLampsAt( vSkyWorld, skyN ) );
`,
    );
  };
  const settle = 3500;
  window.__ab = {
    indoorSkip: { on: () => use(indoorSkip), off: () => use(orig), settle },
    noScreens: { on: () => use(noScreens), off: () => use(orig), settle },
    both: { on: () => use(both), off: () => use(orig), settle },
  };
  return Object.keys(window.__ab);
})();
