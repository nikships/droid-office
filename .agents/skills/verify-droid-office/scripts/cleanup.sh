#!/usr/bin/env bash
# Stops what launch.sh started for <RUN> and removes its scratch folder. Keeps the evidence and lists it.
#
#   .agents/skills/verify-droid-office/scripts/cleanup.sh <RUN>
set -uo pipefail

RUN=${1:-}
[[ -n "$RUN" && -f "$RUN/verify.env" ]] || { echo "cleanup: no verify.env in '${RUN}'" >&2; exit 1; }
[[ "$RUN" == /tmp/verify-droid-office-* ]] || { echo "cleanup: $RUN is not a launch.sh folder" >&2; exit 1; }
# shellcheck source=/dev/null
source "$RUN/verify.env"
node "$(dirname "$0")/evidence-path.mjs" "$RUN" "$EVIDENCE" || { echo "cleanup: refusing to delete a run containing its evidence" >&2; exit 1; }

# The office's process group, then PTY hosts serving sockets inside RUN (they outlive the office).
kill -INT -- "-$PID" 2>/dev/null
for _ in $(seq 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
kill -KILL -- "-$PID" 2>/dev/null
socks=$(find "$RUN" -name pty.sock 2>/dev/null)
[[ -n "$socks" ]] && echo "$socks" | xargs lsof -t 2>/dev/null | sort -u | xargs kill 2>/dev/null

# The office log can carry pairing links: keep a copy with their tokens removed.
[[ -f "$RUN/office.log" ]] && sed -E 's/([?&](t|token)=)[^&[:space:]]+/\1<redacted>/g; s/[0-9a-f]{32,}/<redacted>/g' "$RUN/office.log" >"$EVIDENCE/office.log"
rm -rf "$RUN"

left=$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
[[ -z "$left" ]] && echo "cleanup: :$PORT is free" || echo "cleanup: :$PORT still has a listener ($left)" >&2
[[ -d "$RUN" ]] && echo "cleanup: $RUN still exists" >&2
echo "cleanup: evidence kept in $EVIDENCE:"
find "$EVIDENCE" -type f ! -path '*/profile-*' | sort
