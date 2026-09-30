#!/bin/sh
# Enter VR in the open office tab (no reload), drop the system keyboard, hide the dash, report state.
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
CDP_TIMEOUT=30 node cdp.mjs "$T" '(async () => { const o = window.__office; if (!o.vr.active) await o.vr.enter(); return 1; })()' >/dev/null
sleep 2
adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
sleep 4
CDP_TIMEOUT=10 node cdp.mjs "$T" '(() => { const o = window.__office; o.vr.ui.controls.hide(); const s = o.renderer.xr.getSession(); return [s?.visibilityState, (s?.renderState.layers ?? []).map((l) => l.constructor.name).join("+")].join(" "); })()'
