(async () => {
  const o = window.__office;
  const r = o.renderer;
  const xr = r.xr;
  const s = xr.getSession();
  const gl = r.getContext();
  const b = xr.getBinding();
  const ref = xr.getReferenceSpace();
  const _ui = window.__vrUiForTest || null;
  // Find the controls panel mesh.
  let panel = null;
  o.scene.traverse((x) => {
    const p = x.userData?.panel;
    if (p && Math.abs(p.width - 0.74) < 1e-3 && Math.abs(p.height - 0.66) < 1e-3) panel = p;
  });
  if (!panel) return 'no controls panel';
  panel.setVisible(true);
  panel.markDirty();
  await new Promise((d) => setTimeout(d, 300));
  const canvas = panel.mesh.material.map.image;
  const halfFactor = window.__quadHalf ?? 1;
  const layer = b.createQuadLayer({ space: ref, viewPixelWidth: canvas.width, viewPixelHeight: canvas.height, width: (panel.width / 2) * halfFactor, height: (panel.height / 2) * halfFactor, layout: 'mono', clearOnAccess: false });
  const layers = [layer, ...s.renderState.layers];
  s.updateRenderState({ layers });
  const THREE = { M: panel.mesh.matrixWorld.constructor };
  const inv = new THREE.M();
  const m = new THREE.M();
  const pos = panel.group.position.clone();
  const q = panel.mesh.quaternion.clone();
  const scl = pos.clone();
  // Punch material: world alpha = 1 - panel alpha where the panel is.
  const mat = panel.mesh.material;
  const saved = { blending: mat.blending, blendSrc: mat.blendSrc, blendDst: mat.blendDst, blendSrcAlpha: mat.blendSrcAlpha, blendDstAlpha: mat.blendDstAlpha, blendEquation: mat.blendEquation };
  mat.blending = 5; // CustomBlending
  mat.blendEquation = 100; // AddEquation
  mat.blendSrc = 200; // ZeroFactor
  mat.blendDst = 205; // OneMinusSrcAlphaFactor
  mat.blendSrcAlpha = 200;
  mat.blendDstAlpha = 205;
  mat.needsUpdate = true;
  let uploads = 0;
  window.__quadStop = false;
  const tick = (_t, frame) => {
    if (window.__quadStop) return;
    const dolly = o.vr.dolly;
    dolly.updateMatrixWorld();
    inv.copy(dolly.matrixWorld).invert();
    m.multiplyMatrices(inv, panel.mesh.matrixWorld);
    m.decompose(pos, q, scl);
    layer.transform = new XRRigidTransform({ x: pos.x, y: pos.y, z: pos.z }, { x: q.x, y: q.y, z: q.z, w: q.w });
    if (uploads < 3 || layer.needsRedraw || panel.mesh.material.map.version !== window.__lastV) {
      window.__lastV = panel.mesh.material.map.version;
      const sub = b.getSubImage(layer, frame);
      gl.bindTexture(gl.TEXTURE_2D, sub.colorTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, window.__quadFlip ?? false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
      r.resetState();
      uploads++;
    }
    s.requestAnimationFrame(tick);
  };
  s.requestAnimationFrame(tick);
  window.__quadCleanup = () => {
    window.__quadStop = true;
    Object.assign(mat, saved);
    mat.needsUpdate = true;
    s.updateRenderState({ layers: s.renderState.layers.filter((l) => l !== layer) });
    layer.destroy?.();
  };
  await new Promise((d) => setTimeout(d, 1500));
  return { ok: true, uploads, canvas: [canvas.width, canvas.height], layers: s.renderState.layers.length };
})();
