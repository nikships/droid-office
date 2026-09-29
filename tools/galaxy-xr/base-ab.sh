#!/bin/sh
# Interleaved A/B of the base layer on the built client (which starts on an XRWebGLLayer via
# presentOnWebGLLayer). The proj arm puts createProjectionLayer back for three's setSession.
# Each arm: its own CDP call (fresh gesture), Back to drop the system keyboard, only visible windows count.
cd "$(dirname "$0")"
S=192.168.1.19:5555
T=$(curl -s localhost:9333/json/list | python3 -c 'import json,sys; print([x for x in json.load(sys.stdin) if ":4601/" in x["url"]][0]["webSocketDebuggerUrl"])')
enter() {
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
  sleep 3
  CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
    const o = window.__office; const n = o.renderer.xr.getSession(); if (!n) return 'no session';
    o.vr.ui?.controls?.hide?.();
    await new Promise((d) => setTimeout(d, 1500));
    const t = []; let l = 0;
    await new Promise((d) => { const f = (x) => { if (l) t.push(x - l); l = x; t.length < 120 ? n.requestAnimationFrame(f) : d(); }; n.requestAnimationFrame(f); setTimeout(d, 7000); });
    return [(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1), n.visibilityState, (n.renderState.baseLayer ?? n.renderState.layers.at(-1)).constructor.name, n.renderState.layers?.length ?? 0].join(' ');
  })()" | tr -d '"'
}
for i in $(seq 1 "${1:-3}"); do
  echo "proj  $(enter true)  gpu=$(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/devfreq/cur_freq)"
  echo "webgl $(enter false)  gpu=$(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/devfreq/cur_freq)"
done
