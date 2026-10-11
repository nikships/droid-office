#!/bin/bash
# rec.sh <name> <setup> <action>  — runs <setup> off camera, then records <action> to clips/<name>.mp4.
#
# <setup> and <action> are movement scripts as office-choreography's run.sh takes them (a .js file,
# inline code, or "-" for none). Recording starts after setup resolves and stops when action
# resolves, so the action owns the take's length: end it with an __sleep for a tail to cut on.
# Env: FPS (30; use 60 for camera moves you will slow down), CLEAN=0 keeps the side panels,
#      MOVE_ARG (read by the scripts as window.__arg).
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
RUN="$OFFICE_RIG_DIR/run.sh"
NAME="$1"; SETUP="$2"; ACTION="$3"
if [ -z "$NAME" ] || [ -z "$ACTION" ]; then
  echo "usage: rec.sh <name> <setup.js|code|-> <action.js|code>" >&2
  exit 2
fi
mkdir -p "$CAPTURE_DIR/clips"
OUT="$CAPTURE_DIR/clips/$NAME.mp4"

"$RUN" "__clean(${CLEAN:-1} == 1)" >/dev/null
"$RUN" "${SETUP:--}"
agent-browser record start "$OUT" --fps "${FPS:-30}" >/dev/null
# Stop the recording even when the action fails, so a broken take never keeps recording.
trap 'agent-browser record stop >/dev/null 2>&1 || true' EXIT
"$RUN" "$ACTION"
agent-browser record stop >/dev/null
trap - EXIT
echo "$NAME $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s -> $OUT"
