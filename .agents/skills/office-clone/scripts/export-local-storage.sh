#!/usr/bin/env bash
# Writes the Mac app's droid-office.* localStorage (profile, graphics settings, per-desk models, the
# floor it was on) as one JSON object, read from a copy of its LevelDB, so a test tab on another port
# can load the same settings.
#
#   export-local-storage.sh <Local Storage/leveldb dir> <out.json>
#
# Needs uv; the reader (ccl_chromium_reader) is fetched into uv's cache on first use.
set -euo pipefail
SRC=$1
OUT=$2
TMP=$(mktemp -d /tmp/office-ls-XXXX)
trap 'rm -rf "$TMP"' EXIT
# The app holds the database's LOCK while it runs, so read a copy.
cp -R "$SRC"/. "$TMP/"
rm -f "$TMP/LOCK"
uv run -q --with "ccl_chromium_reader @ git+https://github.com/cclgroupltd/ccl_chromium_reader" python3 - "$TMP" "$OUT" <<'PY'
import json, pathlib, sys
from ccl_chromium_reader import ccl_chromium_localstorage as ls

db = ls.LocalStoreDb(pathlib.Path(sys.argv[1]))
best = {}
for origin in db.iter_storage_keys():
    if not origin.startswith(("http://localhost:", "http://127.0.0.1:")):
        continue
    for rec in db.iter_records_for_storage_key(origin):
        if rec.is_live and rec.script_key.startswith("droid-office.") and rec.leveldb_seq_number >= best.get(rec.script_key, (-1,))[0]:
            best[rec.script_key] = (rec.leveldb_seq_number, rec.value)
out = {k: v for k, (_, v) in sorted(best.items())}
pathlib.Path(sys.argv[2]).write_text(json.dumps(out, indent=1) + "\n")
print(f"{len(out)} keys")
PY
