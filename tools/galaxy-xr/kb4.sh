#!/bin/sh
# Soft keyboard while a session is live: bare session on the office tab and on a blank page.
cd "$(dirname "$0")"
S=192.168.1.19:5555
shown() { adb -s $S shell 'dumpsys input_method | grep -E "mInputShown"' | tr -d ' '; }
tabws() { curl -s localhost:9333/json/list | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin) if x['type']=='page' and '$1' in x['url']]; print(t[0]['webSocketDebuggerUrl'] if t else '')"; }
live() {
  CDP_TIMEOUT=30 node cdp.mjs "$1" "(async () => {
    let s; try { s = await navigator.xr.requestSession('immersive-vr', {}); } catch (e) { return String(e); }
    const c = document.createElement('canvas'); const gl = c.getContext('webgl2', { xrCompatible: true });
    s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) });
    const sp = await s.requestReferenceSpace('local');
    s.requestAnimationFrame(function f(t, fr) { const l = s.renderState.baseLayer; gl.bindFramebuffer(gl.FRAMEBUFFER, l.framebuffer); gl.clearColor(0.2, 0.3, 0.4, 1); gl.clear(gl.COLOR_BUFFER_BIT); s.requestAnimationFrame(f); });
    window.__bare = s;
    await new Promise((d) => setTimeout(d, 3500));
    return s.visibilityState;
  })()" | tr -d '"'
}
end() { CDP_TIMEOUT=15 node cdp.mjs "$1" '(async () => { await window.__bare?.end(); window.__bare = null; await new Promise((d) => setTimeout(d, 1500)); return 1; })()' >/dev/null; }
adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK; sleep 1
T=$(tabws :4601/)
echo "office tab bare live -> $(live "$T") $(shown)"
end "$T"
adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK; sleep 1
curl -s -X PUT "localhost:9333/json/new?https://192.168.1.26:4601/api/health" >/dev/null; sleep 4
B=$(tabws /api/health)
echo "plain page bare live -> $(live "$B") $(shown)"
end "$B"
curl -s "localhost:9333/json/close/$(curl -s localhost:9333/json/list | python3 -c "import json,sys; print([x['id'] for x in json.load(sys.stdin) if '/api/health' in x['url']][0])")" >/dev/null
