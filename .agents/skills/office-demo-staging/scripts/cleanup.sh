#!/bin/bash
# cleanup.sh <owner/repo> [--yes]  — undoes what the staging scripts logged in $CAPTURE_DIR/stage.log.
#
# Without --yes it only prints the plan. With --yes it:
#   1. sends the staged workers still in the office home (CLEANUP=all: worktree folder and local branch),
#   2. closes their open pull requests and deletes the PR branches on the remote,
#   3. closes the staged issues as "not planned" with a comment.
# A PR counts as staged only when its head branch is office/<staged worker, lowercased>-* and it was
# opened after the log's start time, so the owner's older worker branches with the same name are safe.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../../office-choreography/scripts/env.sh"
REPO="$1"; YES="$2"
LOG="$CAPTURE_DIR/stage.log"
[ -n "$REPO" ] && [ -f "$LOG" ] || { echo "usage: cleanup.sh <owner/repo> [--yes]   (needs $LOG)" >&2; exit 2; }
COMMENT="${COMMENT:-Closing: demo item made while filming.}"
START=$(awk '/^start /{print $2; exit}' "$LOG")
WORKERS=$(awk '/^worker /{print $2}' "$LOG" | sort -u)
ISSUES=$(awk '/^issue /{n=$2; sub(/.*\//,"",n); print n}' "$LOG" | sort -un)

PRS=$(gh pr list -R "$REPO" --state open --limit 200 --json number,headRefName,createdAt \
  | python3 -c '
import json, sys
start, names = sys.argv[1], [n.lower() for n in sys.argv[2].split()]
for p in json.load(sys.stdin):
    if p["createdAt"] >= start and any(p["headRefName"].startswith("office/" + n + "-") for n in names):
        print(p["number"], p["headRefName"])
' "$START" "$WORKERS")

PRESENT=""
for w in $WORKERS; do
  if agent-browser eval "office.state().workers.some(x=>x.name==='$w')" 2>/dev/null | grep -q true; then PRESENT="$PRESENT $w"; fi
done

echo "since:   $START"
echo "workers: ${PRESENT:- (none still in the office on this floor)}"
echo "PRs:     $(echo "$PRS" | tr '\n' ' ')"
echo "issues:  $(echo "$ISSUES" | tr '\n' ' ')"
[ "$YES" = "--yes" ] || { echo "dry run: rerun with --yes to do it"; exit 0; }

[ -n "$PRESENT" ] && CLEANUP=all "$DIR/send-home.sh" $PRESENT
echo "$PRS" | while read -r n _; do
  [ -n "$n" ] && gh pr close "$n" -R "$REPO" --delete-branch --comment "$COMMENT"
done
for n in $ISSUES; do
  gh issue close "$n" -R "$REPO" --reason "not planned" --comment "$COMMENT" >/dev/null && echo "closed issue #$n"
done
echo "done $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
