#!/bin/sh
# Which part of entering VR brings up Android's soft keyboard. Each case: end any session, hide
# the keyboard, start a session the given way, render ~2 s, read mInputShown.
cd "$(dirname "$0")"
S=192.168.1.19:5555
T=$(curl -s localhost:9333/json/list | python3 -c 'import json,sys; print([x for x in json.load(sys.stdin) if ":4601/" in x["url"]][0]["webSocketDebuggerUrl"])')
shown() { adb -s $S shell 'dumpsys input_method | grep -E "mInputShown"' | tr -d ' '; }
reset() {
  CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession(); if (s) await s.end(); await new Promise((d) => setTimeout(d, 1200)); return 1; })()' >/dev/null
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 1.5
}
bare() {
  reset
  r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
    let s; try { s = await navigator.xr.requestSession('immersive-vr', $1); } catch (e) { return String(e); }
    const gl = window.__office.renderer.getContext(); await gl.makeXRCompatible();
    s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) });
    await new Promise((d) => { let n = 0; const f = () => { if (++n < 120) s.requestAnimationFrame(f); else d(); }; s.requestAnimationFrame(f); setTimeout(d, 4000); });
    const v = s.visibilityState; const a = document.activeElement?.tagName; await s.end(); return v + ' ' + a;
  })()" | tr -d '"')
  echo "$1 -> $r $(shown)"
}
bare '{}'
bare "{ optionalFeatures: ['local-floor'] }"
bare "{ optionalFeatures: ['hand-tracking'] }"
bare "{ optionalFeatures: ['layers'] }"
bare "{ optionalFeatures: ['bounded-floor'] }"
bare "{ requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'bounded-floor', 'layers'] }"
reset
r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" '(async () => { await window.__office.vr.enter(); await new Promise((d) => setTimeout(d, 3000)); return window.__office.renderer.xr.getSession()?.visibilityState + " " + document.activeElement?.tagName; })()' | tr -d '"')
echo "office enter -> $r $(shown)"
