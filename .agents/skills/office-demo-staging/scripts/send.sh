#!/bin/bash
# send.sh <worker name|desk-id> <prompt>  — types a prompt to a worker through its P dialog and sends it.
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
W="$1"; PROMPT="$2"
[ -n "$W" ] && [ -n "$PROMPT" ] || { echo "usage: send.sh <worker|desk-id> <prompt>" >&2; exit 2; }
PJSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$PROMPT")
WJSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$W")
agent-browser eval "(async()=>{ const o=window.office; await o.closeAll(); await o.goTo($WJSON); const s=await o.interact('P'); return JSON.stringify(s.modals) })()"
agent-browser eval "(() => { const ta = document.querySelector('textarea[aria-label=Prompt]'); if (!ta) throw new Error('no prompt box'); ta.value = $PJSON; ta.dispatchEvent(new Event('input', {bubbles:true})); const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().toUpperCase() === 'SEND'); if (!b) throw new Error('no SEND button'); b.click(); return 'sent' })()"
