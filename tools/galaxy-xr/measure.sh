#!/bin/sh
# Reopen, enter VR, hide the dash, then: layers, fps x3, GPU busy/clock/temp, and the screen's pixels
# (a black or blank frame fails loudly, so a broken frame can't pass as a fast one).
cd "$(dirname "$0")"
S=R3GYB022DBM
./xr.sh reload >/dev/null
T=$(sh tab.sh)
CDP_TIMEOUT=30 node cdp.mjs "$T" '(async () => { await window.__office.vr.enter(); return 1; })()' >/dev/null
sleep 2
adb -s $S shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s $S shell input keyevent KEYCODE_BACK
sleep 5
CDP_TIMEOUT=10 node cdp.mjs "$T" '(window.__office.vr.ui.controls.hide(), 1)' >/dev/null
sleep 1
CDP_TIMEOUT=10 node cdp.mjs "$T" '(() => { const s = window.__office.renderer.xr.getSession(); return [s?.visibilityState, (s?.renderState.layers ?? []).map((l) => l.constructor.name).join("+")].join(" "); })()'
for i in 1 2 3; do ./xr.sh fps | tr -d '\n '; echo; done
echo "gpu busy $(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage) clock $(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/devfreq/cur_freq) temp $(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/temp)"
adb -s $S exec-out screencap -p > m.png
python3 px.py m.png
