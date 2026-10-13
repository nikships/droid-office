#!/usr/bin/env bash
# Copies the owner's installed Droid Office into a scratch folder, so a build can be tested against
# their real configuration without touching the office they use: the office folder (Factory and Jira
# connections, floors, prompts, theme, credits ledger), every floor as a clone of its checkout with
# its real `origin`, each floor's own state (decor, jukebox, Whiteboard, team), and the Mac app's
# browser settings (profile, graphics, per-desk models).
#
#   .agents/skills/office-clone/scripts/clone-office.sh [--office DIR] [--dest DIR] [--port N]
#
# Prints the folder and writes two files into it:
#   start.sh             starts this checkout's built office (dist/) on the copy, on 127.0.0.1
#   local-storage.json   the Mac app's droid-office.* localStorage
#   load-settings.js     an expression that puts those into a test tab and reloads it (see SKILL.md)
#
# Left out on purpose, because a started office acts on them:
#   workers.json, cloud-workers.json, guests.json  a started office resumes every saved worker, so a
#                                                  copy would run the owner's real sessions twice
#   pty.sock, pty-host.*, hook-port, shell.*       the running office's terminals and hooks
#   scrollback/, worktrees/, drops/, wiki-run*     other workers' terminals, checkouts and runs
set -euo pipefail

REAL_HOME=$HOME
OFFICE=""
DEST=""
PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --office) OFFICE=$2; shift 2 ;;
    --dest) DEST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "clone-office: unknown option $1" >&2; exit 2 ;;
  esac
done

CHECKOUT=$(cd "$(dirname "$0")/../../../.." && pwd)
APP_DATA="$REAL_HOME/Library/Application Support/com.nikships.droid-office"

# The office the owner runs: --office, else $DROID_OFFICE_HOME, else the Mac app's officeDir, else ~/droid-office.
if [[ -z "$OFFICE" ]]; then
  if [[ -n "${DROID_OFFICE_HOME:-}" ]]; then OFFICE=$DROID_OFFICE_HOME
  elif [[ -f "$APP_DATA/settings.json" ]]; then OFFICE=$(node -e 'const s=require(process.argv[1]); if (s.officeDir) console.log(s.officeDir)' "$APP_DATA/settings.json")
  fi
  OFFICE=${OFFICE:-$REAL_HOME/droid-office}
fi
[[ -f "$OFFICE/.droid-office/floors.json" ]] || { echo "clone-office: no office in $OFFICE (no .droid-office/floors.json); pass --office" >&2; exit 1; }

DEST=${DEST:-$(mktemp -d /tmp/office-clone-XXXX)}
mkdir -p "$DEST/office" "$DEST/home" "$DEST/floors"

if [[ -z "$PORT" ]]; then
  PORT=4677
  while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
fi

EXCLUDES=(--exclude workers.json --exclude cloud-workers.json --exclude guests.json
  --exclude pty.sock --exclude 'pty-host.*' --exclude hook-port --exclude 'shell.*'
  --exclude scrollback/ --exclude worktrees/ --exclude drops/ --exclude 'wiki-run*'
  --exclude bin/ --exclude 'droid-*.json' --exclude 'system-*.md' --exclude grok-home/ --exclude muse-home/)

copy_state() { # <from dir> <to dir>: a .droid-office folder, minus what a started office would act on
  [[ -d "$1/.droid-office" ]] || return 0
  mkdir -p "$2/.droid-office"
  rsync -a "${EXCLUDES[@]}" "$1/.droid-office/" "$2/.droid-office/"
}

echo "==> office $OFFICE -> $DEST/office"
copy_state "$OFFICE" "$DEST/office"

# Each floor: Home becomes the scratch home folder, a project a local clone with the real origin.
node -e '
const fs = require("fs");
const [file, realHome, dest] = process.argv.slice(1);
const floors = JSON.parse(fs.readFileSync(file, "utf8"));
for (const f of floors) console.log([f.id, f.dir, f.dir === realHome ? `${dest}/home` : `${dest}/floors/${f.id}`].join("\t"));
' "$DEST/office/.droid-office/floors.json" "$REAL_HOME" "$DEST" | while IFS=$'\t' read -r id from to; do
  if [[ "$to" == "$DEST/home" ]]; then
    echo "==> floor $id (Home) -> $to"
  elif git -C "$from" rev-parse --git-dir >/dev/null 2>&1; then
    echo "==> floor $id $from -> $to"
    git clone -q --local "$from" "$to"
    origin=$(git -C "$from" remote get-url origin 2>/dev/null || true)
    if [[ -n "$origin" ]]; then git -C "$to" remote set-url origin "$origin"; else git -C "$to" remote remove origin; fi
    git -C "$to" fetch -q origin 2>/dev/null || true
  else
    echo "==> floor $id $from (not a git checkout) -> $to"
    mkdir -p "$to"
  fi
  copy_state "$from" "$to"
done

node -e '
const fs = require("fs");
const [file, realHome, dest] = process.argv.slice(1);
const floors = JSON.parse(fs.readFileSync(file, "utf8"));
for (const f of floors) f.dir = f.dir === realHome ? `${dest}/home` : `${dest}/floors/${f.id}`;
fs.writeFileSync(file, JSON.stringify(floors, null, 2) + "\n");
' "$DEST/office/.droid-office/floors.json" "$REAL_HOME" "$DEST"

if [[ "$(uname)" == Darwin ]]; then BROWSERS="$REAL_HOME/Library/Caches/droid-office/browsers"; else BROWSERS="${XDG_CACHE_HOME:-$REAL_HOME/.cache}/droid-office/browsers"; fi

# HOME is the scratch home: the office always adds a Home floor there, and the owner's real one holds
# their workers. gh and git keep the owner's sign-in, so the boards read the real forge; the
# Whiteboard renderer uses the owner's downloaded Chromium.
cat >"$DEST/start.sh" <<EOF
#!/usr/bin/env bash
cd "$CHECKOUT"
export HOME="$DEST/home"
export GH_CONFIG_DIR="$REAL_HOME/.config/gh"
export GIT_CONFIG_GLOBAL="$REAL_HOME/.gitconfig"
export DROID_OFFICE_BROWSERS_PATH="$BROWSERS"
unset DROID_OFFICE_HOME DROID_OFFICE_WORKER_ID DROID_OFFICE_HOOK_TOKEN
exec node bin/droid-office.js --home "$DEST/office" --port $PORT --host 127.0.0.1 --projects "$DEST/floors" "\$@"
EOF
chmod +x "$DEST/start.sh"

if [[ -d "$APP_DATA/Local Storage/leveldb" ]]; then
  echo "==> the Mac app's browser settings -> $DEST/local-storage.json"
  if out=$("$(dirname "$0")/export-local-storage.sh" "$APP_DATA/Local Storage/leveldb" "$DEST/local-storage.json" 2>&1); then
    echo "    $out"
    # One expression for the test tab: puts every setting in, then reloads into the owner's profile.
    node -e '
const d = require(process.argv[1]);
process.stdout.write(`(() => { const d = ${JSON.stringify(d)}; for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); setTimeout(() => location.reload(), 50); return Object.keys(d).length + " settings"; })()\n`);
' "$DEST/local-storage.json" >"$DEST/load-settings.js"
  else
    echo "    skipped (the test tab starts with the character picker): $(echo "$out" | tail -1)"
  fi
fi

echo
echo "Cloned the office in $OFFICE to $DEST"
echo "Start it (fireAndForget):  $DEST/start.sh"
echo "Then open:                 http://127.0.0.1:$PORT/"
