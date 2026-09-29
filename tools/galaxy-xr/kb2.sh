#!/bin/sh
# Does a quad layer bring up the soft keyboard? Office enter with layers off, and a bare session
# with one quad layer.
cd "$(dirname "$0")"
S=192.168.1.19:5555
T=$(curl -s localhost:9333/json/list | python3 -c 'import json,sys; print([x for x in json.load(sys.stdin) if ":4601/" in x["url"]][0]["webSocketDebuggerUrl"])')
shown() { adb -s $S shell 'dumpsys input_method | grep -E "mInputShown"' | tr -d ' '; }
reset() {
  CDP_TIMEOUT=20 node cdp.mjs "$T" '(async () => { const s = window.__office.renderer.xr.getSession(); if (s) await s.end(); await new Promise((d) => setTimeout(d, 1200)); return 1; })()' >/dev/null
  adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
  sleep 1.5
}
reset
r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" '(async () => { const v = window.__office.vr; await v.enter(); v.layers.failed = true; v.layers.clear(); await new Promise((d) => setTimeout(d, 3000)); return v.renderer.xr.getSession()?.visibilityState; })()' | tr -d '"')
echo "office enter, layers cleared right away -> $r $(shown)"
reset
r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
  let s; try { s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers', 'local-floor'] }); } catch (e) { return String(e); }
  const gl = window.__office.renderer.getContext(); await gl.makeXRCompatible();
  const base = new XRWebGLLayer(s, gl);
  const space = await s.requestReferenceSpace('local');
  const b = new XRWebGLBinding(s, gl);
  const q = b.createQuadLayer({ space, viewPixelWidth: 512, viewPixelHeight: 512, layout: 'mono', width: 0.5, height: 0.5, transform: new XRRigidTransform({ x: 0, y: 0, z: -1 }) });
  s.updateRenderState({ layers: [q, base] });
  await new Promise((d) => { let n = 0; const f = () => { if (++n < 150) s.requestAnimationFrame(f); else d(); }; s.requestAnimationFrame(f); setTimeout(d, 4000); });
  const v = s.visibilityState; await s.end(); return v;
})()" | tr -d '"')
echo "bare + quad layer -> $r $(shown)"
reset
r=$(CDP_TIMEOUT=30 node cdp.mjs "$T" "(async () => {
  let s; try { s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers', 'local-floor', 'hand-tracking'] }); } catch (e) { return String(e); }
  const gl = window.__office.renderer.getContext(); await gl.makeXRCompatible();
  s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) });
  await s.requestReferenceSpace('local-floor');
  await new Promise((d) => { let n = 0; const f = () => { if (++n < 150) s.requestAnimationFrame(f); else d(); }; s.requestAnimationFrame(f); setTimeout(d, 4000); });
  const v = s.visibilityState; await s.end(); return v;
})()" | tr -d '"')
echo "bare, office features, no quad -> $r $(shown)"
