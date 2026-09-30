#!/bin/sh
# Interleaved A/B on GPU time, not just fps (fps quantizes to 72/36 steps at vsync).
#   abgpu.sh <setup.js> [rounds]    setup.js defines window.__ab = { arm: { on, off, settle } }
# Per window: the page counts XR frames for 3 s while kgsl's gpubusy (a rolling ~1 s busy/total
# window, every GPU client, compositor included) is sampled each second. Reports per arm:
#   ms = GPU busy ms per page frame (median); fps (median); and the thermal clock cap.
# Stops at the first window where the session is gone or not visible.
cd "$(dirname "$0")"
S=R3GYB022DBM
T=$(sh tab.sh)
ROUNDS=${2:-3}
js() { CDP_TIMEOUT=${3:-30} node cdp.mjs "$T" "$1" | tr -d '\n "'; }
ARMS=$(js "$1" | sed 's/.*\[\(.*\)\].*/\1/' | tr ',' ' ' | tr ' ' '\n' | grep -v = | tr '\n' ' ')
echo "arms: $ARMS"
window() {
  OK=$(js '(() => { const s = window.__office.renderer.xr.getSession(); if (!s || s.visibilityState !== "visible") return "bad"; window.__win = { n: 0, t0: 0, t1: 0 }; const w = window.__win; const f = (t) => { if (!w.t0) w.t0 = t; w.t1 = t; w.n++; if (t - w.t0 < 3000) s.requestAnimationFrame(f); }; s.requestAnimationFrame(f); return "ok"; })()')
  [ "$OK" = ok ] || { echo "session not visible ($OK)" >&2; exit 3; }
  B=0; TT=0
  for i in 1 2 3; do
    sleep 1
    set -- $(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/gpubusy)
    B=$((B + $1)); TT=$((TT + $2))
  done
  sleep 0.3
  FPS=$(js '(() => { const w = window.__win; const s = window.__office.renderer.xr.getSession(); return s?.visibilityState === "visible" && w.n > 5 ? ((w.n - 1) * 1000 / (w.t1 - w.t0)).toFixed(1) : "bad"; })()')
  [ "$FPS" = bad ] && { echo "session lost mid-window" >&2; exit 3; }
  python3 -c "print(f'{$B / $TT * 1000 / $FPS:.2f} $FPS')"
}
for arm in $ARMS; do
  OFF_MS=""; ON_MS=""; OFF_F=""; ON_F=""
  settle=$(js "(window.__ab['$arm'].settle ?? 600) / 1000")
  for r in $(seq 1 "$ROUNDS"); do
    js "(async () => { await window.__ab['$arm'].off(); return 1; })()" >/dev/null
    sleep "$settle"
    W=$(window) || exit 3; set -- $W; OFF_MS="$OFF_MS $1"; OFF_F="$OFF_F $2"
    js "(async () => { await window.__ab['$arm'].on(); return 1; })()" >/dev/null
    sleep "$settle"
    W=$(window) || { js "(async () => { await window.__ab['$arm'].off(); return 1; })()" >/dev/null; exit 3; }; set -- $W; ON_MS="$ON_MS $1"; ON_F="$ON_F $2"
  done
  js "(async () => { await window.__ab['$arm'].off(); return 1; })()" >/dev/null
  python3 - "$arm" "$OFF_MS" "$ON_MS" "$OFF_F" "$ON_F" "$(adb -s $S shell cat /sys/class/kgsl/kgsl-3d0/thermal_pwrlevel)" <<'EOF'
import sys, statistics as st
arm, a, b, fa, fb, lvl = sys.argv[1:]
m = lambda s: st.median(float(x) for x in s.split())
print(f"{arm:16} gpu ms/frame off {m(a):5.2f} on {m(b):5.2f} (delta {m(b) - m(a):+5.2f})   fps off {m(fa):4.1f} on {m(fb):4.1f}   thermal level {lvl}")
EOF
done
