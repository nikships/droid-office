#!/bin/sh
# When does an XRWebGLLayer's image reach the display? Each case clears the layer red every frame.
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
endall() { CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession() ?? window.__bare; if (s) await s.end().catch(() => {}); window.__bare = null; await new Promise((d) => setTimeout(d, 1000)); return 1; })()' >/dev/null; }
shot() {
  sleep 2
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 3
  adb -s $S exec-out screencap -p > "wl-$1.png"
  sips -Z 64 "wl-$1.png" --out "wl-$1-s.png" >/dev/null
  echo "$1: $(ls -l "wl-$1.png" | awk '{print $5}') bytes"
}
case_() {
  endall
  CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
    const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers'] });
    const gl = $2;
    await gl.makeXRCompatible?.();
    const base = new XRWebGLLayer(s, gl, { antialias: true, alpha: true });
    const sp = await s.requestReferenceSpace('local');
    $3
    s.requestAnimationFrame(function f(t, fr) { fr.getViewerPose(sp); gl.bindFramebuffer(gl.FRAMEBUFFER, base.framebuffer); gl.clearColor(0.9, 0.2, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT); s.requestAnimationFrame(f); });
    window.__bare = s;
    return 1;
  })()" >/dev/null
  shot "$1"
}
OWN="document.createElement('canvas').getContext('webgl2', { xrCompatible: true, antialias: true })"
OFFICE="window.__office.renderer.getContext()"
case_ own-baseLayer "$OWN" "s.updateRenderState({ baseLayer: base });"
case_ own-layersArray "$OWN" "s.updateRenderState({ layers: [base] });"
case_ office-baseLayer "$OFFICE" "s.updateRenderState({ baseLayer: base });"
case_ own-base-then-layers "$OWN" "s.updateRenderState({ baseLayer: base }); await new Promise((d) => s.requestAnimationFrame(d)); s.updateRenderState({ layers: [base] });"
endall
