// Where the frame goes: noRender skips three's scene render (frame still submitted, JS update runs);
// noUpdate skips the office's per-frame update but still renders; tinyViewport cuts fragment work.
(() => {
  const o = window.__office;
  const r = o.renderer;
  const gl = r.getContext();
  const V = (window.__glViewport ??= gl.viewport);
  const tiny = function (x, y, w, h) {
    return V.call(this, x / 8, y / 8, Math.max(1, w / 8), Math.max(1, h / 8));
  };
  const R = (window.__render ??= r.render);
  const noRender = (scene, camera) => {
    r.clear();
    void scene;
    void camera;
  };
  const vr = o.vr;
  const U = (window.__vrUpdate ??= vr.update);
  window.__ab = {
    tinyViewport: {
      on: () => {
        gl.viewport = tiny;
      },
      off: () => {
        gl.viewport = V;
      },
    },
    noRender: {
      on: () => {
        r.render = noRender;
      },
      off: () => {
        r.render = R;
      },
    },
    noVrUpdate: {
      on: () => {
        vr.update = () => {};
      },
      off: () => {
        vr.update = U;
      },
    },
  };
  return Object.keys(window.__ab);
})();
