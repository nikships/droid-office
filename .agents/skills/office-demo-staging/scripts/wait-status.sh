#!/bin/bash
# wait-status.sh <worker name> <status> [timeout s=300] [--via <status>]
#
# Polls office.state() from the shell, one short eval a second, until the worker has <status>
# (starting, working, needs_input, done, idle). With --via, it first has to be seen in that status,
# so `--via working` waits for the next working -> done flip (the confetti) and not an old done.
# Waiting inside one long in-page eval drops the browser connection, which is why this exists.
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
W="$1"; WANT="$2"; TIMEOUT="${3:-300}"; VIA=""
[ "$4" = "--via" ] && VIA="$5"
[ -n "$W" ] && [ -n "$WANT" ] || { echo "usage: wait-status.sh <worker> <status> [timeout] [--via status]" >&2; exit 2; }
seen=$([ -z "$VIA" ] && echo 1 || echo 0)
end=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$end" ]; do
  s=$(agent-browser eval "(office.state().workers.find(w=>w.name==='$W')||{}).status||'gone'" 2>/dev/null | tr -d '"')
  [ "$s" = "$VIA" ] && seen=1
  if [ "$seen" = 1 ] && [ "$s" = "$WANT" ]; then echo "$W is $s"; exit 0; fi
  sleep 1
done
echo "timed out: $W is ${s:-unknown}" >&2
exit 1
