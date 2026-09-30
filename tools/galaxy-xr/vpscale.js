// Does Chrome honor XRView.requestViewportScale? Patch getViewerPose to request a scale for every
// view before three reads the viewports, then measure fps and the viewport three actually drew.
(async () => {
  const o = window.__office;
  const r = o.renderer;
  const s = r.xr.getSession();
  async function measure(n = 60) {
    const t = [];
    let l = 0;
    await new Promise((d) => {
      const f = (x) => {
        if (l) t.push(x - l);
        l = x;
        t.length < n ? s.requestAnimationFrame(f) : d();
      };
      s.requestAnimationFrame(f);
      setTimeout(d, 6000);
    });
    return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
  }
  const wait = (ms) => new Promise((d) => setTimeout(d, ms));
  const vp = () =>
    r.xr
      .getCamera()
      .cameras.map((c) => `${c.viewport.z}x${c.viewport.w}`)
      .join(' ');
  const P = XRFrame.prototype.getViewerPose;
  let scale = 1;
  XRFrame.prototype.getViewerPose = function (space) {
    const pose = P.call(this, space);
    if (pose) for (const v of pose.views) v.requestViewportScale?.(scale);
    return pose;
  };
  const out = {};
  for (const sc of [1, 0.7, 0.5, 1]) {
    scale = sc;
    await wait(700);
    out[`s${sc}`] = { fps: await measure(), viewports: vp() };
  }
  XRFrame.prototype.getViewerPose = P;
  return out;
})();
