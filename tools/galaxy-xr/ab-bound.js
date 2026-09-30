// CPU vs GPU: tinyViewport divides every viewport by 8 (fragment work ~1/64, CPU and vertex work
// unchanged). Also tries navigator.virtualKeyboard.hide().
(() => {
  const o = window.__office;
  const gl = o.renderer.getContext();
  const V = (window.__glViewport ??= gl.viewport);
  const tiny = function (x, y, w, h) {
    return V.call(this, x / 8, y / 8, Math.max(1, w / 8), Math.max(1, h / 8));
  };
  window.__ab = {
    tinyViewport: {
      on: () => {
        gl.viewport = tiny;
      },
      off: () => {
        gl.viewport = V;
      },
    },
  };
  return {
    toggles: Object.keys(window.__ab),
    vk: typeof navigator.virtualKeyboard,
    vkHide: (() => {
      try {
        navigator.virtualKeyboard?.hide();
        return 'called';
      } catch (e) {
        return String(e);
      }
    })(),
  };
})();
