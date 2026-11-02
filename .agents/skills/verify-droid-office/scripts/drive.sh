#!/usr/bin/env bash
# Runs one steps file against a launched verification office and files its evidence.
#
#   .agents/skills/verify-droid-office/scripts/drive.sh <RUN> <steps.mjs|-> <name> [--native]
#
# "-" runs no steps (a render check that saves office.png). --native drives this checkout's Electron
# app (the Mac app) instead of the headless shell; doctor.sh says whether this Mac allows it.
# Writes $EVIDENCE/<name>/: the screenshots, transcript.txt (everything the runner printed) and
# exit-code. Exits with the runner's code.
set -euo pipefail

[[ $# -ge 3 ]] || { sed -n '2,10p' "$0" >&2; exit 2; }
RUN=$1 STEPS=$2 NAME=$3
NATIVE=${4:-}
[[ -f "$RUN/verify.env" ]] || { echo "drive: $RUN has no verify.env: start one with launch.sh" >&2; exit 1; }
# shellcheck source=/dev/null
source "$RUN/verify.env"
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "drive: name must be a plain word" >&2; exit 2; }

OUT="$EVIDENCE/$NAME"
mkdir -p "$OUT"
ARGS=("$CHECKOUT/.agents/skills/office-clone/scripts/office-run.mjs" "$RUN")
[[ "$STEPS" == - ]] || ARGS+=("$(cd "$(dirname "$STEPS")" && pwd)/$(basename "$STEPS")")
ARGS+=(--out "$OUT" --timeout "${VERIFY_TIMEOUT:-180}")
[[ "$NATIVE" == --native ]] && ARGS+=(--source "$CHECKOUT")

set +e
VERIFY_RUN=$RUN VERIFY_EVIDENCE=$EVIDENCE VERIFY_OUT=$OUT node "${ARGS[@]}" 2>&1 | tee "$OUT/transcript.txt"
code=${PIPESTATUS[0]}
set -e
echo "$code" >"$OUT/exit-code"
echo "drive: $NAME exited $code; evidence in $OUT"
exit "$code"
