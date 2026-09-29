#!/bin/sh
# Headset-off iteration helper for the office on Galaxy XR over adb. Defaults to USB, which works
# whatever the Mac's VPN does to LAN routes: the headset reaches the office through
# `adb reverse tcp:4600` at http://localhost:4600 (localhost is a secure context, so WebXR runs
# without the HTTPS proxy), and DevTools comes back over `adb forward`.
#   xr.sh status   awake/worn state, VR session state, office tab id
#   xr.sh wake     wake the headset (only stays awake with the proximity sensor covered)
#   xr.sh reload   reopen the office tab (ends the VR session)
#   xr.sh enter    enter VR from the page (no headset input needed)
#   xr.sh fps      measure the XR frame rate for ~2 s
#   xr.sh shot [f] screenshot to f (default ./shot.png)
# Wi-Fi instead: ANDROID_SERIAL=192.168.1.19:5555 XR_URL=https://192.168.1.26:4601/ XR_MATCH=:4601/ xr.sh ...
set -e
export ANDROID_SERIAL="${ANDROID_SERIAL:-R3GYB022DBM}"
export XR_URL="${XR_URL:-http://localhost:4600/}"
export XR_MATCH="${XR_MATCH:-localhost:4600/}"
PORT=9333
DIR=$(dirname "$0")
case "$ANDROID_SERIAL" in *:*) adb connect "$ANDROID_SERIAL" >/dev/null 2>&1 || true ;; *) adb reverse tcp:4600 tcp:4600 >/dev/null ;; esac
adb forward tcp:$PORT localabstract:chrome_devtools_remote >/dev/null
tab() { sh "$DIR/tab.sh"; }
js() { node "$DIR/cdp.mjs" "$(tab)" "$1"; }
case "$1" in
  status)
    adb shell 'dumpsys power | grep -E "mWakefulness=|mXrDonDetected|mLastSleepReason"'
    js '(() => { const o = window.__office; const s = o?.renderer.xr.getSession(); const l = s?.renderState.layers; return { vr: !!o?.vr.active, visibility: s?.visibilityState, layers: l?.map((x) => x.constructor.name) }; })()' ;;
  wake) adb shell input keyevent KEYCODE_WAKEUP; sleep 1; adb shell 'dumpsys power | grep -E "mWakefulness="' ;;
  # A reload hits the office's "Reload site?" prompt (leave.ts), which also stalls CDP; a fresh tab doesn't.
  reload)
    for id in $(curl -s localhost:$PORT/json/list | python3 -c 'import json,sys,os; [print(x["id"]) for x in json.load(sys.stdin) if x["type"]=="page" and os.environ["XR_MATCH"] in x["url"]]'); do curl -s -m5 localhost:$PORT/json/close/$id >/dev/null; done
    sleep 1; adb shell am start -a android.intent.action.VIEW -d "$XR_URL" com.android.chrome >/dev/null; sleep 12; echo reloaded ;;
  enter) js '(async () => { await window.__office.vr.enter(); await new Promise((d) => setTimeout(d, 2500)); return window.__office.vr.active; })()' ;;
  fps) js '(async () => { const s = window.__office.renderer.xr.getSession(); if (!s) return "no session"; const t = []; let l = 0; await new Promise((d) => { const f = (x) => { if (l) t.push(x - l); l = x; t.length < 120 ? s.requestAnimationFrame(f) : d(); }; s.requestAnimationFrame(f); setTimeout(d, 8000); }); t.sort((a, b) => a - b); const avg = t.reduce((a, b) => a + b, 0) / t.length; return { fps: +(1000 / avg).toFixed(1), p50ms: +t[t.length >> 1].toFixed(1), p95ms: +t[Math.floor(t.length * 0.95)].toFixed(1) }; })()' ;;
  shot) adb exec-out screencap -p > "${2:-./shot.png}"; echo "${2:-./shot.png}" ;;
  *) sed -n '2,13p' "$0" ;;
esac
