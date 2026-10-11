#!/bin/bash
# send-home.sh <worker name>...  — sends workers home off camera, the way the X dialog's SEND HOME does.
#
# Env CLEANUP: what becomes of each worktree — all (default: folder and local branch), worktree
# (folder only), keep. "all" loses commits that were never pushed; a demo worker's PR branch is on
# the remote, so cleanup.sh closes the PR and deletes that branch separately.
# Sends `worker.kill` over a second WebSocket from the capture tab; names that are not on the
# tab's current floor are refused, so ride there first.
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
[ $# -gt 0 ] || { echo "usage: send-home.sh <worker name>..." >&2; exit 2; }
NAMES=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")
CL="${CLEANUP:-all}"
cat <<EOF | agent-browser eval --stdin
(async () => {
  const names = $NAMES;
  const workers = office.state().workers;
  const ids = names.map((n) => {
    const w = workers.find((w) => w.name === n);
    if (!w) throw new Error(n + ' is not on this floor (' + office.state().floor.id + ')');
    return w.id;
  });
  const q = new URLSearchParams({ name: 'capture', color: '#888888', floor: office.state().floor.id });
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?' + q);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('websocket failed')); });
  await new Promise((r) => setTimeout(r, 800));
  for (const id of ids) ws.send(JSON.stringify({ t: 'worker.kill', workerId: id, cleanup: '$CL' }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && office.state().workers.some((w) => ids.includes(w.id))) await new Promise((r) => setTimeout(r, 300));
  ws.close();
  return JSON.stringify({ left: office.state().workers.map((w) => w.name + ':' + w.status) });
})()
EOF
