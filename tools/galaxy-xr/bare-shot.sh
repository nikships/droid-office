#!/bin/sh
# A bare session on an XRWebGLLayer that clears to a known color: does the headset show it?
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession(); if (s) await s.end(); await new Promise((d) => setTimeout(d, 1000)); return 1; })()' >/dev/null
CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
  const s = await navigator.xr.requestSession('immersive-vr', {});
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2', { xrCompatible: true, antialias: ${1:-true} });
  s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl, { antialias: ${1:-true} }) });
  const sp = await s.requestReferenceSpace('local');
  s.requestAnimationFrame(function f(t, fr) { fr.getViewerPose(sp); const l = s.renderState.baseLayer; gl.bindFramebuffer(gl.FRAMEBUFFER, l.framebuffer); gl.clearColor(0.9, 0.2, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT); s.requestAnimationFrame(f); });
  window.__bare = s;
  return 1;
})()" >/dev/null
sleep 2
adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
sleep 3
adb -s $S exec-out screencap -p > bare.png
sips -Z 300 bare.png --out bare-s.png >/dev/null
CDP_TIMEOUT=15 node cdp.mjs "$T" '(async () => { await window.__bare?.end(); return 1; })()' >/dev/null
python3 -c "
from PIL import Image
im = Image.open('./bare.png').convert('RGB').resize((32, 32))
px = list(im.getdata()); print('mean rgb', [sum(p[i] for p in px) // len(px) for i in range(3)])
" 2>/dev/null || echo "(no PIL)"
