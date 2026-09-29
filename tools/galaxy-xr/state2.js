(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  let rt = null;
  const R = r.render;
  r.render = function (a, b) {
    rt = r.getRenderTarget();
    r.render = R;
    return R.call(this, a, b);
  };
  await new Promise((d) => s.requestAnimationFrame(d));
  await new Promise((d) => s.requestAnimationFrame(d));
  const lights = {};
  o.scene.traverse((x) => {
    if (x.isLight && x.visible) {
      const k = `${x.type}${x.castShadow ? '+shadow' : ''}`;
      lights[k] = (lights[k] ?? 0) + 1;
    }
  });
  const layer = s.renderState.layers?.[0];
  const mats = {};
  o.scene.traverse((x) => {
    if (!x.visible) return;
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) mats[m.type] = (mats[m.type] ?? 0) + 1;
  });
  const sm = r.shadowMap;
  const shadowCasters = [];
  o.scene.traverse((x) => {
    if (x.isLight && x.castShadow) shadowCasters.push({ type: x.type, size: x.shadow.mapSize.toArray(), radius: x.shadow.radius, auto: x.shadow.autoUpdate, cam: x.shadow.camera.type });
  });
  return {
    rt: rt && { w: rt.width, h: rt.height, samples: rt.samples, resolveDepth: rt.resolveDepthBuffer, depthTex: !!rt.depthTexture, storeMSDepth: rt._storeMultisampledDepthBuffer ?? rt.storeMultisampledDepthBuffer },
    layers: s.renderState.layers?.map((l) => l.constructor.name),
    ignoreDepthValues: layer?.ignoreDepthValues,
    texW: layer?.textureWidth,
    texH: layer?.textureHeight,
    texArray: layer?.textureArrayLength,
    lights,
    shadowCasters,
    shadowType: sm.type,
    shadowAuto: sm.autoUpdate,
    mats,
    toneMapping: r.toneMapping,
    outputCS: r.outputColorSpace,
    fog: o.scene.fog?.type,
    pixelRatio: r.getPixelRatio(),
  };
})();
