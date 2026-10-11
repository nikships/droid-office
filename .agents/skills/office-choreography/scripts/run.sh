#!/bin/bash
# run.sh <move.js|code>...  — runs movement scripts in the office tab, one after another.
#
# Each argument is a .js file holding one async IIFE, or the same code inline. The rig is loaded
# first if a reload cleared it, and MOVE_ARG (any string) is set as window.__arg for the script to
# read: a desk id, a floor, an issue number. Prints what each script resolves with.
set -e
source "$(dirname "$0")/env.sh"
[ $# -gt 0 ] || { echo "usage: run.sh <move.js|code>..." >&2; exit 2; }
agent-browser eval "!!window.__pan" 2>/dev/null | grep -q true || agent-browser eval --stdin < "$OFFICE_RIG_DIR/office-rig.js" >/dev/null
ARG_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${MOVE_ARG:-}")
agent-browser eval "window.__arg = $ARG_JSON; 'ok'" >/dev/null
for m in "$@"; do
  [ "$m" = "-" ] && continue
  if [ -f "$m" ]; then agent-browser eval --stdin < "$m"; else printf '%s' "$m" | agent-browser eval --stdin; fi
done
