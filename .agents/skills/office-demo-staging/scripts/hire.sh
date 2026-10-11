#!/bin/bash
# hire.sh <desk-id> <model label|""> <prompt>  — hires a worker at a free desk through its P dialog,
# always in its own worktree, and logs it to $CAPTURE_DIR/stage.log for cleanup.sh.
#
# The model label is the text in the dialog's Droid model list (e.g. "Haiku 4.5", "Opus 5.5");
# "" keeps the default. Buttons are clicked from script, not with a real click, so the tab does not
# grab pointer lock (which would stop the camera rig turning).
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
DESK="$1"; MODEL="$2"; PROMPT="$3"
[ -n "$DESK" ] && [ -n "$PROMPT" ] || { echo "usage: hire.sh <desk-id> <model label|\"\"> <prompt>" >&2; exit 2; }
js() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
PJSON=$(js "$PROMPT"); MJSON=$(js "$MODEL")
ALLOW_NO_WT=$([ "${ALLOW_NO_WORKTREE:-0}" = 1 ] && echo true || echo false)

agent-browser eval "(async()=>{ const o=window.office; await o.closeAll(); if (o.state().workers.some(w=>w.deskId==='$DESK')) throw new Error('$DESK is taken'); await o.goTo('$DESK'); const s=await o.interact('P'); return JSON.stringify(s.modals) })()"
cat <<EOF | agent-browser eval --stdin
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ta = document.querySelector('textarea[aria-label=Prompt]');
  if (!ta) throw new Error('no prompt box: is the hire dialog open?');
  ta.value = $PJSON;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const wt = [...document.querySelectorAll('input[type=checkbox]')].find((c) => /worktree/i.test(c.closest('label')?.textContent || c.getAttribute('aria-label') || ''));
  // The dialog offers a worktree only on a floor whose checkout is on a git branch.
  if (!wt && !$ALLOW_NO_WT) throw new Error('no worktree option: the floor is not on a git branch, so this worker would work in the folder itself. Rerun with ALLOW_NO_WORKTREE=1 if that is fine.');
  if (wt && !wt.checked) wt.click();
  let model = 'default';
  const want = $MJSON;
  if (want) {
    model = 'NOT FOUND';
    // The model list fills in after the dialog opens.
    for (let i = 0; i < 40 && model === 'NOT FOUND'; i++) {
      const sel = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.text.trim() === want));
      if (sel) {
        sel.value = [...sel.options].find((o) => o.text.trim() === want).value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        model = want;
      } else await sleep(250);
    }
    if (model === 'NOT FOUND') throw new Error('model not offered: ' + want);
  }
  await sleep(300);
  const btn = [...document.querySelectorAll('button')].find((b) => /hire\s*&\s*start/i.test(b.textContent));
  if (!btn) throw new Error('no HIRE & START button');
  btn.click();
  return 'worktree=' + !!wt?.checked + ' model=' + model;
})()
EOF
name=""
for _ in $(seq 1 20); do
  name=$(agent-browser eval "(office.state().workers.find(w=>w.deskId==='$DESK')||{}).name||''" | tr -d '"')
  [ -n "$name" ] && break
  sleep 0.5
done
[ -n "$name" ] || { echo "no worker appeared at $DESK" >&2; exit 1; }
LOG="$CAPTURE_DIR/stage.log"
grep -q '^start ' "$LOG" 2>/dev/null || echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
echo "worker $name $DESK" >> "$LOG"
echo "hired $name at $DESK"
