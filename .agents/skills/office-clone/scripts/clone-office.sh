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
  [[ "$1" != --office && "$1" != --dest && "$1" != --port || $# -ge 2 ]] || { echo "clone-office: $1 needs a value" >&2; exit 2; }
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

[[ -z "$PORT" || "$PORT" =~ ^[0-9]+$ ]] || { echo "clone-office: --port takes a number" >&2; exit 2; }

# The copy holds the owner's Factory and Jira keys: only they may read it.
DEST=${DEST:-$(mktemp -d /tmp/office-clone-XXXX)}
mkdir -p "$DEST/office" "$DEST/home" "$DEST/floors"
chmod 700 "$DEST"

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
# Rewrites the copied floors.json to point there, and prints id, real folder and copy for each.
MAP=$(node -e '
const fs = require("fs");
const [file, realHome, dest] = process.argv.slice(1);
const norm = (p) => { try { return fs.realpathSync(p); } catch { return p.replace(/\/+$/, ""); } };
const floors = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = [];
for (const f of floors) {
  if (!/^[\w-]{1,64}$/.test(f.id)) throw new Error(`floor id ${JSON.stringify(f.id)} is not a plain name`);
  const to = norm(f.dir) === norm(realHome) ? `${dest}/home` : `${dest}/floors/${f.id}`;
  rows.push([f.id, f.dir, to].join("\t"));
  f.dir = to;
}
fs.writeFileSync(`${file}.tmp`, JSON.stringify(floors, null, 2) + "\n");
fs.renameSync(`${file}.tmp`, file);
console.log(rows.join("\n"));
' "$DEST/office/.droid-office/floors.json" "$REAL_HOME" "$DEST")

# Read on fd 3: git and rsync in the loop may read stdin.
while IFS=$'\t' read -r -u 3 id from to; do
  [[ -n "$id" ]] || continue
  if [[ "$to" == "$DEST/home" ]]; then
    echo "==> floor $id (Home) -> $to"
  elif git -C "$from" rev-parse --git-dir >/dev/null 2>&1; then
    echo "==> floor $id $from -> $to"
    git clone -q --local -- "$from" "$to"
    origin=$(git -C "$from" remote get-url origin 2>/dev/null || true)
    if [[ -n "$origin" ]]; then git -C "$to" remote set-url origin "$origin"; else git -C "$to" remote remove origin; fi
    git -C "$to" fetch -q origin 2>/dev/null || true
  else
    echo "==> floor $id $from (not a git checkout) -> $to"
    mkdir -p "$to"
  fi
  copy_state "$from" "$to"
done 3<<<"$MAP"

if [[ "$(uname)" == Darwin ]]; then BROWSERS="$REAL_HOME/Library/Caches/droid-office/browsers"; else BROWSERS="${XDG_CACHE_HOME:-$REAL_HOME/.cache}/droid-office/browsers"; fi

# HOME is the scratch home: the office always adds a Home floor there, and the owner's real one holds
# their workers. gh and git keep the owner's sign-in, so the boards read the real forge; the
# Whiteboard renderer uses the owner's downloaded Chromium. %q keeps any path a single word.
{
  echo '#!/usr/bin/env bash'
  printf 'cd %q\n' "$CHECKOUT"
  printf 'export HOME=%q\n' "$DEST/home"
  printf 'export GH_CONFIG_DIR=%q\n' "$REAL_HOME/.config/gh"
  printf 'export GIT_CONFIG_GLOBAL=%q\n' "$REAL_HOME/.gitconfig"
  printf 'export DROID_OFFICE_BROWSERS_PATH=%q\n' "$BROWSERS"
  echo 'unset DROID_OFFICE_HOME DROID_OFFICE_WORKER_ID DROID_OFFICE_HOOK_TOKEN'
  printf 'exec node bin/droid-office.js --home %q --port %s --host 127.0.0.1 --projects %q "$@"\n' "$DEST/office" "$PORT" "$DEST/floors"
} >"$DEST/start.sh"
chmod 700 "$DEST/start.sh"

if [[ -d "$APP_DATA/Local Storage/leveldb" ]]; then
  echo "==> the Mac app's browser settings -> $DEST/local-storage.json"
  if out=$("$(dirname "$0")/export-local-storage.sh" "$APP_DATA/Local Storage/leveldb" "$DEST/local-storage.json" 2>&1); then
    echo "    $out"
    # One expression for the test tab: puts every setting in, then reloads into the owner's profile.
    # Concatenated, not a template literal: a stored value can hold a backtick or ${.
    node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[2], "(() => { const d = " + JSON.stringify(d) + "; for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); setTimeout(() => location.reload(), 50); return Object.keys(d).length + \" settings\"; })()\n");
' "$DEST/local-storage.json" "$DEST/load-settings.js"
  else
    echo "    skipped (the test tab starts with the character picker): $(echo "$out" | tail -1)"
  fi
fi

echo
echo "Cloned the office in $OFFICE to $DEST"
echo "Start it (fireAndForget):  $DEST/start.sh"
echo "Then open:                 http://127.0.0.1:$PORT/"
