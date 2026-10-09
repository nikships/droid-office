#!/usr/bin/env bash
# Sets a Factory Droid Computer up for work on this repository. It is the repository's setup
# script in the computer's build steps (it runs from the clone, after global setup):
#
#   bash deploy/factory-computer.sh
#
# Installs Node.js 22 (test:coverage needs 22.8+), git, the GitHub CLI, build tools and the Droid
# CLI where they're missing, then runs `npm ci`, whose prepare script installs the pre-commit hook
# and builds the client and server. Idempotent: safe to re-run on every build.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Electron is only for the Mac app; a Linux computer never runs it.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

step() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

cd "$(dirname "$0")/.."

SUDO=()
if [[ $(id -u) -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo -E)
  else
    echo "factory-computer: needs root or sudo to install packages" >&2
    exit 1
  fi
fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 8) ? 0 : 1)'
}

if command -v apt-get >/dev/null 2>&1; then
  APT=("${SUDO[@]}" apt-get -y -q -o DPkg::Lock::Timeout=600)

  step "Installing git, GitHub CLI and build tools"
  "${APT[@]}" update
  "${APT[@]}" install curl ca-certificates gnupg
  # gh from GitHub's own apt repo: Ubuntu's archive freezes it at whatever shipped with the release.
  "${SUDO[@]}" install -d -m 755 /etc/apt/keyrings
  "${SUDO[@]}" curl -fsSLo /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
  "${SUDO[@]}" chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    "${SUDO[@]}" tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  if ! node_ok; then
    step "Adding the Node.js 22 apt repository"
    curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" bash -
  fi
  "${APT[@]}" update
  pkgs=(git gh build-essential python3)
  node_ok || pkgs+=(nodejs)
  "${APT[@]}" install "${pkgs[@]}"
  hash -r
elif ! node_ok; then
  echo "factory-computer: no apt-get here, so install Node.js 22.8+ in global setup" >&2
  exit 1
fi

if ! node_ok; then
  # An older node earlier on PATH (nvm, a toolcache) shadows the one apt installed.
  echo "factory-computer: $(command -v node) is $(node -v); Node.js 22.8+ is needed. Put /usr/bin first on PATH." >&2
  exit 1
fi

export PATH="$HOME/.local/bin:$PATH"
if ! command -v droid >/dev/null 2>&1; then
  step "Installing the Droid CLI"
  curl -fsSL https://app.factory.ai/cli | sh
fi

step "npm ci (installs the pre-commit hook, builds the client and the server)"
npm ci --no-audit --no-fund

step "Ready"
echo "    node $(node -v), npm $(npm -v)"
echo "    $(git --version)"
command -v gh >/dev/null 2>&1 && echo "    $(gh --version | head -1)"
command -v droid >/dev/null 2>&1 && echo "    droid $(droid --version 2>/dev/null | head -1)"
echo "    Check it with: npm run lint && npm run typecheck && npm test"
