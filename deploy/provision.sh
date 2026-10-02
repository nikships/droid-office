#!/usr/bin/env bash
# Runs ON the EC2 instance (piped over ssh by deploy/aws.sh). Idempotent: safe to re-run.
# Expects these to be exported by the caller: APP_REPO APP_REF PROJECT_REPO (optional)
# PUBLIC_HOST GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY GIT_NAME GIT_EMAIL
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT=(sudo -E apt-get -y -q -o DPkg::Lock::Timeout=600)

step() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
# Run quietly; show the output only when something fails.
quiet() {
  local log
  log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    tail -n 40 "$log" >&2
    echo "provision: failed: $*" >&2
    exit 1
  fi
  rm -f "$log"
}

step "Waiting for the instance to finish booting"
sudo cloud-init status --wait >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  step "Installing Node.js 22"
  quiet bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'
  quiet "${APT[@]}" install nodejs
fi

step "Installing git, GitHub CLI and build tools"
# gh from GitHub's own apt repo: Ubuntu's archive freezes it at whatever shipped with the release.
# install upgrades it to the newest on every re-run.
sudo install -d -m 755 /etc/apt/keyrings
quiet sudo curl -fsSLo /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
quiet "${APT[@]}" update
quiet "${APT[@]}" install git gh curl ca-certificates build-essential python3
echo "    $(gh --version | head -1)"

if [[ ! -x "$HOME/.local/bin/claude" ]]; then
  step "Installing Claude Code"
  quiet bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi
export PATH="$HOME/.local/bin:$PATH"
echo "    claude $(claude --version 2>/dev/null | head -1)"

step "Writing secrets to /etc/droid-office/env"
sudo install -d -m 755 /etc/droid-office
env_file=$(mktemp)
{
  # The address the owner SSHes to, so the office can show the tunnel command.
  [[ -n "${PUBLIC_HOST:-}" ]] && printf 'DROID_OFFICE_PUBLIC_HOST="%s"\n' "$PUBLIC_HOST"
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && printf 'CLAUDE_CODE_OAUTH_TOKEN="%s"\n' "$CLAUDE_CODE_OAUTH_TOKEN"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && printf 'ANTHROPIC_API_KEY="%s"\n' "$ANTHROPIC_API_KEY"
  true
} >"$env_file"
sudo install -m 600 -o root -g root "$env_file" /etc/droid-office/env
rm -f "$env_file"

if [[ -n "${GH_TOKEN:-}" ]]; then
  step "Signing the GitHub CLI in"
  # Stored in gh's own config, so gh, git (via gh's credential helper), the office's boards, the
  # workers and your ssh sessions all use it — and the token never lands in a .git/config.
  printf '%s' "$GH_TOKEN" | quiet env -u GH_TOKEN gh auth login --hostname github.com --git-protocol https --with-token
  quiet env -u GH_TOKEN gh auth setup-git --hostname github.com
  echo "    $(env -u GH_TOKEN gh api user --jq '"as " + .login' 2>/dev/null || echo 'signed in')"
fi
[[ -n "${GIT_NAME:-}" ]] && git config --global user.name "$GIT_NAME"
[[ -n "${GIT_EMAIL:-}" ]] && git config --global user.email "$GIT_EMAIL"
git config --global init.defaultBranch main

step "Installing droid-office ($APP_REF) from $APP_REPO"
sudo install -d -o "$USER" -g "$USER" /opt/droid-office
if [[ -d /opt/droid-office/.git ]]; then
  quiet git -C /opt/droid-office fetch --depth 1 origin "$APP_REF"
  quiet git -C /opt/droid-office reset --hard FETCH_HEAD
else
  quiet git clone --depth 1 --branch "$APP_REF" "$APP_REPO" /opt/droid-office
fi
echo "    at $(git -C /opt/droid-office log -1 --format='%h %s')"
step "npm install (builds the office)"
(cd /opt/droid-office && quiet npm install --no-audit --no-fund)

# The office keeps its data (floors, workers, boards, the queue) in ~/droid-office and
# clones projects into ~/workspace/<owner>/<repo>. It starts with no project: its elevator
# lists every repository the GitHub token can see, and cloning one makes it the first floor.
OFFICE_HOME="$HOME/droid-office"
WORKSPACE="$HOME/workspace"
mkdir -p "$WORKSPACE"
# Offices provisioned before that ran in one project's checkout, with their data in it: they carry
# on there, so nobody loses their floors. That project can be taken off in the elevator.
LEGACY_DIR=""
if [[ -f /etc/droid-office/dir ]]; then
  legacy=$(cat /etc/droid-office/dir)
  [[ -f "$legacy/.droid-office/config.json" ]] && LEGACY_DIR="$legacy"
fi
if [[ -n "$LEGACY_DIR" ]]; then
  step "Keeping the office in $LEGACY_DIR (its floors are there)"
  RUN_DIR="$LEGACY_DIR"
  OFFICE_ARGS="$LEGACY_DIR "
else
  RUN_DIR="$HOME"
  OFFICE_ARGS=""
  setup_args=()
  # Once: after that, the folder is the admins' to move in ⚙️ Settings.
  [[ -f "$OFFICE_HOME/.droid-office/projects-folder.json" ]] || setup_args+=(--projects "$WORKSPACE")
  [[ -n "${PROJECT_REPO:-}" ]] && setup_args+=(--project "$PROJECT_REPO")
  if [[ ${#setup_args[@]} -gt 0 ]]; then
    step "Setting up the office${PROJECT_REPO:+: cloning $PROJECT_REPO as a floor}"
    # It won't touch a running office's floors (the service restarts below anyway).
    sudo systemctl stop droid-office >/dev/null 2>&1 || true
    node /opt/droid-office/bin/droid-office.js setup "${setup_args[@]}" </dev/null ||
      echo "    (carrying on: add projects from the office's elevator)"
  fi
  sudo rm -f /etc/droid-office/dir
fi
echo "$OFFICE_HOME" | sudo tee /etc/droid-office/home >/dev/null
[[ -n "$LEGACY_DIR" ]] && echo "$LEGACY_DIR" | sudo tee /etc/droid-office/dir >/dev/null

step "Pre-accepting Claude Code onboarding and folder trust"
# The workspace (every project is cloned under it), and an older office's own project.
node - "$WORKSPACE" ${LEGACY_DIR:+"$LEGACY_DIR"} <<'NODE'
const fs = require('fs');
const file = `${process.env.HOME}/.claude.json`;
let c = {};
try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
c.hasCompletedOnboarding = true;
c.projects = c.projects || {};
for (const dir of process.argv.slice(2)) c.projects[dir] = { ...(c.projects[dir] || {}), hasTrustDialogAccepted: true };
const key = process.env.ANTHROPIC_API_KEY;
if (key) {
  c.customApiKeyResponses = c.customApiKeyResponses || { approved: [], rejected: [] };
  if (!c.customApiKeyResponses.approved.includes(key.slice(-20))) c.customApiKeyResponses.approved.push(key.slice(-20));
}
fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
NODE

# Only the owner reaches this box, over SSH as its own user with a plain `ssh -L`
# tunnel (see deploy/aws.sh): there is no restricted tunnel user anymore, so nothing
# here manages extra keys, helpers or sshd rules for one.
step "Installing the droid-office service (restarts itself if it ever crashes)"
unit=$(mktemp)
cat >"$unit" <<UNIT
[Unit]
Description=Droid Office
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=$RUN_DIR
EnvironmentFile=/etc/droid-office/env
Environment=HOME=$HOME
Environment=DROID_OFFICE_HOME=$OFFICE_HOME
Environment=SHELL=/bin/bash
Environment=PATH=$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Lets the office upgrade itself from its UI: it builds the new version, then exits, and
# Restart=always brings it back up on that version.
Environment=DROID_OFFICE_SELF_UPDATE=1
# Loopback only: the office is reached through an SSH tunnel, never from the internet.
ExecStart=/usr/bin/node /opt/droid-office/bin/droid-office.js ${OFFICE_ARGS}--host 127.0.0.1 --port 4600
Restart=always
RestartSec=3
# Stopping or restarting the office stops the office, not its workers: their terminals run in a
# process of their own that the next office picks back up. The default, control-group, would stop
# every worker mid-task on each upgrade.
KillMode=process
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 644 "$unit" /etc/systemd/system/droid-office.service
rm -f "$unit"
sudo systemctl daemon-reload
sudo systemctl enable droid-office >/dev/null 2>&1
sudo systemctl restart droid-office

step "Done"
