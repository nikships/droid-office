#!/bin/bash
# Lists or force-kills the Droid Office processes (main and helpers) whose executable lives under a directory, by PID.
#
#   tools/frame-bench/kill-own.sh list [dir]    print "pid<TAB>command" for each, exit status 1 when there are some
#   tools/frame-bench/kill-own.sh kill [dir]    SIGKILL each by PID and print what it killed
#
# dir defaults to /tmp/droid-office-measure. An app started with `open` shows up under /private/tmp, so both spellings match. Always SIGKILL, never SIGTERM or pkill by name: the packaged app asks
# "Leave the office?" on unload and a terminated app sits frozen behind that dialog on the screen.
MODE=${1:-list}
ROOT=${2:-/tmp/droid-office-measure}
PIDS=$(ps -axo pid=,command= | awk -v root="$ROOT" '{ pid = $1; $1 = ""; cmd = substr($0, 2) } (index(cmd, root "/") == 1 || index(cmd, "/private" root "/") == 1) && index(cmd, "Droid Office.app/Contents/") > 0 { print pid "\t" cmd }')
[ -z "$PIDS" ] && exit 0
echo "$PIDS" | cut -c1-200
if [ "$MODE" = kill ]; then
  echo "$PIDS" | cut -f1 | while read -r pid; do kill -KILL "$pid" 2>/dev/null; done
  sleep 1
  exit 0
fi
exit 1
