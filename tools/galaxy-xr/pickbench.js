// Time pickFromRay directly: 200 rays fanned from the eye over the office, BVH on vs three's own.
(async () => {
  const o = window.__office;
  const vr = o.vr;
  const rc = vr.raycaster;
  const cam = o.renderer.xr.getCamera();
  const V = cam.position.constructor;
  const eye = new V().setFromMatrixPosition(cam.matrixWorld);
  const rays = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    rays.push(new V(Math.cos(a), -0.25 + (0.5 * ((i * 7) % 13)) / 13, Math.sin(a)).normalize());
  }
  const run = () => {
    let hits = 0;
    const t0 = performance.now();
    for (const d of rays) {
      rc.set(eye, d);
      rc.far = vr.hooks.reachOf('tv') + 6;
      rc.camera = o.camera;
      if (vr.hooks.pickFromRay(rc, 0)) hits++;
    }
    return { ms: +((performance.now() - t0) / rays.length).toFixed(3), hits };
  };
  const out = { built: vr.rayAccel.built, bvh: run() };
  const acc = vr.rayAccel;
  const patched = [...acc.patched];
  const saved = patched.map((m) => m.raycast);
  for (const m of patched) delete m.raycast;
  out.plain = run();
  patched.forEach((m, i) => (m.raycast = saved[i]));
  out.bvhAgain = run();
  return out;
})();
