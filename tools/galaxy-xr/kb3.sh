#!/bin/sh
# Bisects the office's enter for the soft keyboard: three's setSession alone, then with onEnter's UI.
cd "$(dirname "$0")"
S=192.168.1.19:5555
T=$(curl -s localhost:9333/json/list | python3 -c 'import json,sys; print([x for x in json.load(sys.stdin) if ":4601/" in x["url"]][0]["webSocketDebuggerUrl"])')
shown() { adb -s $S shell 'dumpsys input_method | grep -E "mInputShown"' | tr -d ' '; }
reset() {
  CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession(); if (s) await s.end(); await new Promise((d) => setTimeout(d, 1500)); return 1; })()' >/dev/null
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 1.5
}
run() {
  reset
  r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
    const o = window.__office; const r = o.renderer;
    let s; try { s = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'bounded-floor', 'layers'] }); } catch (e) { return String(e); }
    $1
    await new Promise((d) => setTimeout(d, 3500));
    return s.visibilityState;
  })()" | tr -d '"')
  echo "$2 -> $r $(shown)"
}
run "r.xr.setReferenceSpaceType('local-floor'); await r.xr.setSession(s);" "three setSession (projection layer)"
run "r.xr.setReferenceSpaceType('local-floor'); const P = XRWebGLBinding.prototype; const d = Object.getOwnPropertyDescriptor(P, 'createProjectionLayer'); delete P.createProjectionLayer; try { await r.xr.setSession(s); } finally { Object.defineProperty(P, 'createProjectionLayer', d); }" "three setSession (webgl layer)"
run "const gl = r.getContext(); await gl.makeXRCompatible(); s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) }); const c = r.domElement; c.width = 3712; c.height = 2159;" "bare + canvas resized"
run "const gl = r.getContext(); await gl.makeXRCompatible(); s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) }); s.requestAnimationFrame(function f() { s.requestAnimationFrame(f); });" "bare, frames never drawn"
reset
