// Shader-cost toggles for abx.js: each wraps the office's shared onBeforeCompile (sky.ts) and
// strips one part after it runs. A distinct function body gives each variant its own program key.
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
  const LIGHT = /if \( skyOn > 0\.0 \) \{\s*vec3 skyLight[\s\S]*?BRDF_Lambert\( material\.diffuseColor \);\s*\}/;
  const noLamps = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(LIGHT, '/*nolamps*/');
  };
  const noHaze = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace(/float skyReach[\s\S]*?\);\n\s*float fogFactor = [^\n]*\n/, 'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );\n');
  };
  const noSky = (s, r) => {
    void s;
    void r; /* plain three shaders */
  };
  const noShadowSample = function (s, r) {
    orig.call(this, s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_begin>', '#undef USE_SHADOWMAP\n#include <lights_fragment_begin>');
  };
  const settle = 3500;
  window.__ab = {
    noLamps: { on: () => use(noLamps), off: () => use(orig), settle },
    noHaze: { on: () => use(noHaze), off: () => use(orig), settle },
    noSkyAtAll: { on: () => use(noSky), off: () => use(orig), settle },
    noShadowSample: { on: () => use(noShadowSample), off: () => use(orig), settle },
  };
  return Object.keys(window.__ab);
})();
