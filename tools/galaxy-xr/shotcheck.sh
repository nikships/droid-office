#!/bin/sh
# Screenshots of the world on each base layer: webgl with quad layers, webgl without, projection with quads.
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
restart() {
  CDP_TIMEOUT=40 node cdp.mjs "$T" "(async () => {
    const o = window.__office; const xr = o.renderer.xr;
    const s = xr.getSession(); if (s) { await s.end(); await new Promise((d) => setTimeout(d, 800)); }
    window.__origSet ??= xr.setSession;
    const P = XRWebGLBinding.prototype;
    window.__cpl ??= Object.getOwnPropertyDescriptor(P, 'createProjectionLayer');
    xr.setSession = $1 ? async function (x) { Object.defineProperty(P, 'createProjectionLayer', window.__cpl); try { return await window.__origSet.call(this, x); } finally { delete P.createProjectionLayer; } } : window.__origSet;
    await o.vr.enter();
    return !!xr.getSession();
  })()" >/dev/null
  sleep 2
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 4
  CDP_TIMEOUT=10 node cdp.mjs "$T" '(window.__office.vr.ui.controls.hide(), window.__office.vr.ui.menu.hide(), 1)' >/dev/null
  sleep 1
}
restart false
adb -s $S exec-out screencap -p > webgl-quads.png
CDP_TIMEOUT=10 node cdp.mjs "$T" '(() => { const l = window.__office.vr.layers; l.clear(); l.failed = true; return 1; })()' >/dev/null
sleep 2
adb -s $S exec-out screencap -p > webgl-noquads.png
restart true
adb -s $S exec-out screencap -p > proj-quads.png
for f in webgl-quads webgl-noquads proj-quads; do sips -Z 600 $f.png --out $f-s.png >/dev/null; done
python3 - <<'EOF'
import struct, zlib
def mean(p):
    d = open(p, 'rb').read()
    w, h = struct.unpack('>II', d[16:24])
    return w, h, len(d)
for f in ['webgl-quads', 'webgl-noquads', 'proj-quads']:
    print(f, mean(f'./{f}.png'))
EOF
