#!/bin/bash
# boot.sh — opens (or reopens) the office in a headed agent-browser session with the movement rig loaded.
#
# Safe to run again whenever the session drops or comes back as about:blank.
# Env: OFFICE_URL, AGENT_BROWSER_SESSION, CAPTURE_W/CAPTURE_H (1920x1080),
#      OFFICE_SETTINGS (load-settings.js from office-clone: the owner's profile and settings),
#      OFFICE_NAME/OFFICE_COLOR (a profile, only without OFFICE_SETTINGS; skips the character picker),
#      OFFICE_FLOOR (floor id to ride to once in, e.g. droid-office).
set -e
source "$(dirname "$0")/env.sh"
W="${CAPTURE_W:-1920}"; H="${CAPTURE_H:-1080}"
NAME_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${OFFICE_NAME:-Demo}")
COLOR_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${OFFICE_COLOR:-#ef6f2e}")

# ?pace=full keeps this tab drawing every frame. Without it the office drops to ~5 FPS after 30 s
# of stillness and stops while covered, which ruins static and long takes.
case "$OFFICE_URL" in *\?*) URL="$OFFICE_URL&pace=full" ;; *) URL="${OFFICE_URL%/}/?pace=full" ;; esac
agent-browser --headed open "$URL" >/dev/null
agent-browser set viewport "$W" "$H" >/dev/null
# droid-office.worktree=1: hires (including handing a carried issue card to a desk) get their own
# worktree and branch instead of working in the owner's checkout.
# Set after the owner's settings, which carry their own droid-office.worktree.
if [ -n "$OFFICE_SETTINGS" ]; then
  [ -r "$OFFICE_SETTINGS" ] || { echo "boot.sh: can't read OFFICE_SETTINGS ($OFFICE_SETTINGS)" >&2; exit 1; }
  agent-browser eval --stdin < "$OFFICE_SETTINGS" >/dev/null
  # load-settings.js reloads 50 ms later; wait for that before setting the flag on the new page.
  sleep 2
  agent-browser eval "localStorage.setItem('droid-office.worktree','1'); location.reload(); 'ok'" >/dev/null
  sleep 2
else
  agent-browser eval "localStorage.setItem('droid-office.profile', JSON.stringify({name:$NAME_JSON,color:$COLOR_JSON,look:{}})); localStorage.setItem('droid-office.worktree','1'); location.reload(); 'ok'" >/dev/null
fi

ready=false
for _ in $(seq 1 40); do
  r=$(agent-browser eval "!!(window.office && office.state().floor && office.state().player.controls)" 2>/dev/null || true)
  if [ "$r" = "true" ]; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "office not ready at $OFFICE_URL (still loading, or the character picker is up)" >&2
  exit 1
fi

agent-browser eval --stdin < "$OFFICE_RIG_DIR/office-rig.js" >/dev/null
if [ -n "$OFFICE_FLOOR" ]; then
  agent-browser eval "(async()=>{ if (office.state().floor.id!=='$OFFICE_FLOOR') await office.ride('$OFFICE_FLOOR'); return office.state().floor.id })()" >/dev/null
fi
agent-browser eval "JSON.stringify({floor: office.state().floor.id, workers: office.state().workers.map(w => w.name + '@' + w.desk + ':' + w.status)})"
