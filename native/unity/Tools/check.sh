#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$project/../.." && pwd)"
node "$project/Tools/fetch-compiler.mjs"
cd "$root"
node --import tsx "$project/Tools/snapshot.ts" --check
mkdir -p "$project/Evidence"
# Close only this project's saved Editor before using the isolated batch runner.
unity test "$project" --editor-version 6000.3.25f1 --mode EditMode \
  --output "$project/Evidence/editmode.xml" --timeout 600 --format json
