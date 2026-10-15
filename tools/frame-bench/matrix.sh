#!/bin/bash
# The whole comparison matrix on one build, unattended: the same scenarios, caps and methods for every build, so two
# builds compare like for like. Needs the display (take the display lock first), a running office clone, and display-trace.
#
#   tools/frame-bench/matrix.sh <Droid Office.app> <office clone> <out dir> <label> [full|quick] [display-trace binary]
#
# full:  120 FPS cap, 3 configs x 4 scenarios x 3 rounds; input latency at 120/60/40; 60 and 40 FPS caps, 1 round;
#        the light bake load at 120/60/40. About 40 minutes.
# quick: 120 FPS cap, SDR and HDR, walk and terminal, 2 rounds, with resource use. About 8 minutes.
# Every scenario row carries the page's frameStats, the display trace, the app's CPU, memory and GPU utilization, and
# the native presenter's stats when the build has them. A step that overruns its limit is killed and the next one runs.
# DEADLINE_MIN (default 42) stops starting new steps once that many minutes have passed since the start.
set -u
APP=${1:?app}
CLONE=${2:?clone}
OUT=${3:?out}
LABEL=${4:?label}
MODE=${5:-full}
TRACE=${6:-/tmp/droid-office-measure/display-trace}
DEADLINE_MIN=${DEADLINE_MIN:-42}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
START=$(date +%s)
LOG="$OUT/matrix.log"
exec > >(tee -a "$LOG") 2>&1

elapsed() { echo $(( ($(date +%s) - START) / 60 )); }
step() { echo "=== $(date +%H:%M:%S) (+$(elapsed) min, load $(uptime | sed 's/.*averages: //')) $*"; }

# Runs a command with a time limit in seconds; kills its process group when it overruns.
limited() {
  local limit=$1
  shift
  "$@" &
  local pid=$!
  (sleep "$limit" && echo "step overran $limit s, killing" && kill -TERM "$pid" 2>/dev/null) &
  local watcher=$!
  wait "$pid"
  local status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  # The app may outlive a killed bench.
  pkill -f "$(realpath "$APP")" 2>/dev/null
  pkill -f "$APP" 2>/dev/null
  sleep 3
  return $status
}

bench() {
  # bench <limit s> <out sub dir> <bench args...>
  local limit=$1 sub=$2
  shift 2
  limited "$limit" node "$HERE/bench.mjs" --app "$APP" --clone "$CLONE" --display-trace "$TRACE" --out "$OUT/$sub" --label "$LABEL" --resources "$@"
}

late() {
  if [ "$(elapsed)" -ge "$DEADLINE_MIN" ]; then
    echo "=== deadline of $DEADLINE_MIN min reached, skipping $*"
    return 0
  fi
  return 1
}

if [ "$MODE" = quick ]; then
  step "quick: 120 FPS cap, SDR and HDR"
  for cfg in remastered-sdr remastered-hdr; do
    late "$cfg" || bench 900 quick --configs "$cfg" --caps 120 --scenarios walk,terminal --seconds 12 --repeat 2 --seed 11
  done
  step done
  exit 0
fi

# Each configuration runs on its own so its light bake is made once and every round after it loads it from the cache
# (every launch starts from an empty profile). The order is fixed; rounds repeat it.
step "120 FPS cap, 3 rounds"
for cfg in remastered-sdr remastered-hdr classic; do
  late "$cfg @120" || bench 1500 c120 --configs "$cfg" --caps 120 --scenarios idle,turn,walk,terminal --seconds 12 --repeat 3 --seed 21
done

step "input latency at 120, 60 and 40"
late latency || limited 900 node "$HERE/latency.mjs" --app "$APP" --clone "$CLONE" --display-trace "$TRACE" --out "$OUT/latency" --config remastered-sdr --caps 120,60,40 --trials 80 --label "$LABEL"

step "60 and 40 FPS caps, 1 round"
for cfg in remastered-sdr remastered-hdr classic; do
  late "$cfg @60,40" || bench 900 c60 --configs "$cfg" --caps 60,40 --scenarios idle,walk,terminal --seconds 12 --repeat 1 --seed 31
done

step "load and light bake at 120, 60 and 40"
late load || bench 1500 load --configs remastered-sdr --caps 120,60,40 --scenarios load --seed 41

step "tables"
for sub in c120 c60 load quick; do
  [ -f "$OUT/$sub/results.jsonl" ] && { echo "## $sub"; node "$HERE/bench.mjs" --table "$OUT/$sub/results.jsonl"; } >> "$OUT/tables.md"
done
step done
