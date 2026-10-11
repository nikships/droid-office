#!/bin/bash
# demo-issues.sh <owner/repo> <issues.tsv>  — opens one demo issue per TSV row: title<TAB>labels<TAB>body.
#
# Labels are comma separated and must already exist in the repository. Each new issue URL is
# logged to $CAPTURE_DIR/stage.log, which cleanup.sh uses to close exactly these issues afterwards.
# The issues board picks them up on its next refresh.
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
REPO="$1"; TSV="$2"
[ -n "$REPO" ] && [ -f "$TSV" ] || { echo "usage: demo-issues.sh <owner/repo> <issues.tsv>" >&2; exit 2; }
LOG="$CAPTURE_DIR/stage.log"
grep -q '^start ' "$LOG" 2>/dev/null || echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
while IFS=$'\t' read -r title labels body; do
  [ -z "$title" ] && continue
  url=$(gh issue create -R "$REPO" --title "$title" --label "$labels" --body "$body")
  echo "issue $url" >> "$LOG"
  echo "$url"
done < "$TSV"
