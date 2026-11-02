#!/usr/bin/env bash
# Read-only: is this verification office worth driving? Prints one line per check and exits 1 on
# any "fail". Run it first, and again after any drive that failed or surprised you.
#
#   .agents/skills/verify-droid-office/scripts/doctor.sh <RUN>
set -uo pipefail

RUN=${1:-}
[[ -n "$RUN" && -f "$RUN/verify.env" ]] || { echo "fail  no verify.env in '${RUN}': start an office with launch.sh"; exit 1; }
# shellcheck source=/dev/null
source "$RUN/verify.env"
bad=0
ok() { echo "ok    $*"; }
warn() { echo "warn  $*"; }
fail() { echo "fail  $*"; bad=1; }

[[ "$PORT" != 4600 ]] && ok "port :$PORT is not the owner's :4600" || fail "port is :4600, the owner's office"
if kill -0 "$PID" 2>/dev/null; then ok "office pid $PID is alive (mode $MODE)"; else fail "office pid $PID is gone: see $RUN/office.log"; fi

listener=$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
if [[ -z "$listener" ]]; then
  fail "nothing listens on :$PORT"
elif [[ "$(ps -o pgid= -p "$listener" | tr -d ' ')" == "$PID" ]]; then
  ok "listener on :$PORT (pid $listener) belongs to this run's process group"
else
  fail "listener on :$PORT is pid $listener, not this run's office: someone else owns the port"
fi

for path in / /dashboard; do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT$path")
  [[ "$code" == 200 ]] && ok "GET $path 200" || fail "GET $path answered $code"
done
hookfile=$(find "$RUN" -maxdepth 5 -name hook-port -path '*/.droid-office/*' 2>/dev/null | head -1)
hook=$([[ -n "$hookfile" ]] && tr -dc '0-9' <"$hookfile")
if [[ -z "$hook" ]]; then
  warn "no hook-port file under $RUN yet: Office MCP checks skipped"
else
  mcp=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "http://127.0.0.1:$hook/office/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  [[ "$mcp" == 401 || "$mcp" == 403 ]] && ok "Office MCP on hook port :$hook refuses an anonymous call ($mcp)" || fail "Office MCP on :$hook answered an anonymous call with $mcp"
fi

head=$(git -C "$CHECKOUT" rev-parse --short HEAD)
built=$(stat -f %m "$CHECKOUT/dist/server/server/cli.js" 2>/dev/null || stat -c %Y "$CHECKOUT/dist/server/server/cli.js")
newest=$(git -C "$CHECKOUT" ls-files -z src bin | xargs -0 stat -f %m 2>/dev/null | sort -n | tail -1)
if [[ -n "$newest" && "$newest" -gt "$built" ]]; then warn "dist/ is older than src/ at $head: npm run build, then relaunch"; else ok "serving $CHECKOUT at $head, dist/ newer than src/"; fi

[[ -f "$RUN/local-storage.json" ]] && ok "browser profile present (local-storage.json)" || warn "no local-storage.json: the office opens on the character picker"

if [[ "$(uname)" == Darwin ]]; then
  chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
  electron=$(cd "$CHECKOUT" && node -p "require('electron')" 2>/dev/null)
  if [[ ! "$chip" =~ (Pro|Max|Ultra)$ ]]; then
    warn "native Mac app unavailable: $chip is a base chip and the app refuses it (drive headless; do not set DROID_OFFICE_ALLOW_ANY_CHIP)"
  elif [[ -z "$electron" || ! -x "$electron" ]]; then
    warn "native Mac app unavailable: no Electron binary (run npm ci with install scripts allowed)"
  else
    ok "native Mac app available: drive.sh ... --native"
  fi
fi

owner=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:4600/ || true)
[[ "$owner" == 200 ]] && ok "the owner's office answers on :4600: leave it alone" || ok "no office on :4600"
if command -v adb >/dev/null 2>&1; then
  n=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' ')
  ok "adb sees $n Android device(s)"
fi
ok "evidence goes to $EVIDENCE"
exit "$bad"
