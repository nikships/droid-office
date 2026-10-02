#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$project/Evidence"
unity build "$project" --editor-version 6000.3.25f1 --target Android \
  --execute-method DroidOffice.Editor.BuildSettings.Android --timeout 1200 --format json
