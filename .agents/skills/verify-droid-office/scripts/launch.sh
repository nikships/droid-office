#!/usr/bin/env bash
# Starts an isolated Droid Office for verification and waits until it is usable.
#
#   .agents/skills/verify-droid-office/scripts/launch.sh [--fresh] [--office DIR] [--port N]
#
# Default: a clone of the owner's installed office (office-clone's clone-office.sh).
# --fresh: no owner office on this machine (the Mac Mini runner). A new office whose one floor is a
#          local git clone of this checkout, with its real origin.
# Prints RUN (scratch, removed by cleanup.sh) and EVIDENCE (kept). Never serves :4600.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=$(cd "$HERE/../../../.." && pwd)
MODE=clone
CLONE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) MODE=fresh; shift ;;
    --office | --port) [[ $# -ge 2 ]] || { echo "launch: $1 needs a value" >&2; exit 2; }; CLONE_ARGS+=("$1" "$2"); shift 2 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "launch: unknown option $1" >&2; exit 2 ;;
  esac
done

[[ -f "$CHECKOUT/dist/server/server/cli.js" ]] || { echo "launch: no build in $CHECKOUT/dist: run npm run build" >&2; exit 1; }

RUN=$(mktemp -d /tmp/verify-droid-office-XXXX)
RUN_ID=$(basename "$RUN")
EVIDENCE="${VERIFY_EVIDENCE_ROOT:-/tmp/verify-droid-office-evidence}/$RUN_ID"
mkdir -p "$EVIDENCE"
PID=""
# A launch that fails leaves nothing behind but the evidence it gathered.
on_exit() {
  local code=$?
  [[ $code == 0 ]] && return
  if [[ -n "$PID" ]]; then "$HERE/cleanup.sh" "$RUN" >&2; else rm -rf "$RUN"; rmdir "$EVIDENCE" 2>/dev/null; fi
  exit "$code"
}
trap on_exit EXIT

if [[ "$MODE" == clone ]]; then
  "$CHECKOUT/.agents/skills/office-clone/scripts/clone-office.sh" --dest "$RUN" ${CLONE_ARGS[@]+"${CLONE_ARGS[@]}"} >"$RUN/clone.log" 2>&1 || {
    echo "launch: clone-office.sh failed (log: $EVIDENCE/clone.log). On a machine with no installed office, rerun with --fresh." >&2
    tail -3 "$RUN/clone.log" >&2
    cp "$RUN/clone.log" "$EVIDENCE/" 2>/dev/null || true
    exit 1
  }
else
  PORT=4677
  for ((i = 0; i < ${#CLONE_ARGS[@]}; i += 2)); do [[ "${CLONE_ARGS[i]}" == --port ]] && PORT=${CLONE_ARGS[i + 1]}; done
  while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
  mkdir -p "$RUN/home" "$RUN/floors" "$RUN/office"
  chmod 700 "$RUN"
  git clone -q --local -- "$CHECKOUT" "$RUN/floors/droid-office"
  git -C "$RUN/floors/droid-office" remote set-url origin "$(git -C "$CHECKOUT" remote get-url origin)"
  {
    echo '#!/usr/bin/env bash'
    printf 'cd %q\n' "$CHECKOUT"
    printf 'export HOME=%q\n' "$RUN/home"
    printf 'export GH_CONFIG_DIR=%q\n' "${GH_CONFIG_DIR:-$HOME/.config/gh}"
    printf 'export GIT_CONFIG_GLOBAL=%q\n' "$HOME/.gitconfig"
    printf 'export DROID_OFFICE_BROWSERS_PATH=%q\n' "$HOME/Library/Caches/droid-office/browsers"
    echo 'unset DROID_OFFICE_HOME DROID_OFFICE_WORKER_ID DROID_OFFICE_HOOK_TOKEN'
    echo 'export DROID_OFFICE_REMOTE_MCP="${DROID_OFFICE_REMOTE_MCP:-off}"'
    printf 'exec node bin/droid-office.js %q --home %q --port %s --host 127.0.0.1 --projects %q "$@"\n' "$RUN/floors/droid-office" "$RUN/office" "$PORT" "$RUN/floors"
  } >"$RUN/start.sh"
  chmod 700 "$RUN/start.sh"
  # A profile for the test browser, as a clone carries the owner's, so the office opens past the character picker.
  echo '{"droid-office.profile":"{\"name\":\"Verifier\",\"color\":\"#4f86f7\",\"look\":{\"skin\":2,\"hair\":1,\"style\":0}}"}' >"$RUN/local-storage.json"
fi

PORT=$(sed -nE 's/.*--port ([0-9]+).*/\1/p' "$RUN/start.sh")
[[ -n "$PORT" && "$PORT" != 4600 ]] || { echo "launch: refusing port ${PORT:-?}: :4600 is the owner's office" >&2; exit 1; }

# Its own session, so the office outlives this shell and cleanup.sh can stop the whole group.
python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$RUN/start.sh" </dev/null >"$RUN/office.log" 2>&1 &
PID=$!
printf 'RUN=%q\nEVIDENCE=%q\nPORT=%s\nPID=%s\nMODE=%s\nCHECKOUT=%q\n' "$RUN" "$EVIDENCE" "$PORT" "$PID" "$MODE" "$CHECKOUT" >"$RUN/verify.env"

for _ in $(seq 90); do
  kill -0 "$PID" 2>/dev/null || { echo "launch: the office exited; see $RUN/office.log" >&2; tail -20 "$RUN/office.log" >&2; exit 1; }
  root=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  dash=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dashboard" || true)
  [[ "$root" == 200 && "$dash" == 200 ]] && break
  sleep 1
done
[[ "$root" == 200 && "$dash" == 200 ]] || { echo "launch: :$PORT answered / $root, /dashboard $dash after 90 s" >&2; exit 1; }

# Ready means usable: a real browser run reaches window.office with the loading screen gone.
"$HERE/drive.sh" "$RUN" - launch

echo "RUN=$RUN"
echo "EVIDENCE=$EVIDENCE"
echo "PORT=$PORT PID=$PID MODE=$MODE"
