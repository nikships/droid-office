#!/bin/sh
# Isolates the 'layers' feature: same bare XRWebGLLayer session with and without it.
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
endall() { CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession() ?? window.__bare; if (s) await s.end().catch(() => {}); window.__bare = null; await new Promise((d) => setTimeout(d, 1000)); return 1; })()' >/dev/null; }
case_() {
  endall
  CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
    const s = await navigator.xr.requestSession('immersive-vr', $2);
    const gl = document.createElement('canvas').getContext('webgl2', { xrCompatible: true, antialias: true });
    const base = new XRWebGLLayer(s, gl, { antialias: true });
    s.updateRenderState({ baseLayer: base });
    const sp = await s.requestReferenceSpace('local');
    s.requestAnimationFrame(function f(t, fr) { fr.getViewerPose(sp); gl.bindFramebuffer(gl.FRAMEBUFFER, base.framebuffer); gl.clearColor(0.9, 0.2, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT); s.requestAnimationFrame(f); });
    window.__bare = s;
    return s.enabledFeatures.join(',');
  })()" | tr -d '\n'
  sleep 2
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 3
  adb -s $S exec-out screencap -p > "wl-$1.png"
  echo "  $1: $(ls -l "wl-$1.png" | awk '{print $5}') bytes (39197 = black)"
}
case_ no-layers "{}"
case_ with-layers "{ optionalFeatures: ['layers'] }"
case_ no-layers-again "{ optionalFeatures: ['local-floor'] }"
endall
