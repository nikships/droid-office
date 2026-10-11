#!/usr/bin/env bash
# Sets a Factory Droid Computer up for work on this repository. It is the repository's setup
# script in the computer's build steps (it runs from the clone, after global setup):
#
#   bash deploy/factory-computer.sh
#
# Installs Node.js 22 (test:coverage needs 22.8+), git, the GitHub CLI, build tools and the Droid
# CLI where they're missing, then runs `npm ci`, whose prepare script installs the pre-commit hook
# and builds the client and server. Idempotent: safe to re-run on every build.
#
# It also sets the computer up for pull requests with screenshot and video proof: agent-browser
# and Playwright with their Chromium, Xvfb for headed browsers (the office's WebGL needs one),
# ffmpeg, Pillow, emoji fonts and the gh-image extension, which uploads pictures and video to a PR
# with the GH_TOKEN computer secret.
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
  pkgs=(git gh build-essential python3 jq
    ffmpeg xvfb xauth python3-pil fonts-noto-color-emoji fonts-liberation fonts-dejavu-core)
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

step "Installing agent-browser and Playwright"
NPM_G=(npm)
[[ -w "$(npm prefix -g)/lib" ]] || NPM_G=("${SUDO[@]}" env "PATH=$PATH" npm)
"${NPM_G[@]}" install -g --no-audit --no-fund agent-browser@latest playwright@latest
hash -r
if command -v apt-get >/dev/null 2>&1; then
  "${SUDO[@]}" env "PATH=$PATH" playwright install-deps chromium
fi
# Browsers go to the user's own cache (~/.cache), so these run without sudo.
playwright install chromium
agent-browser install

# Global packages are only require()-able with NODE_PATH, so a proof script can
# require('playwright') from any folder.
NODE_PATH_LINE="export NODE_PATH=\"$(npm root -g)\""
echo "$NODE_PATH_LINE" | "${SUDO[@]}" tee /etc/profile.d/droid-office-tools.sh >/dev/null
touch "$HOME/.bashrc"
grep -qxF "$NODE_PATH_LINE" "$HOME/.bashrc" || echo "$NODE_PATH_LINE" >>"$HOME/.bashrc"

step "Installing the gh-image extension (uploads screenshots and video to pull requests)"
if ! gh extension list 2>/dev/null | grep -q 'drogers0/gh-image'; then
  # gh extension install needs gh signed in, which a build may not be (GH_TOKEN can be a
  # session-only secret), so fall back to laying the release binary out the way gh does.
  if ! gh extension install drogers0/gh-image 2>/dev/null; then
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) arch="" ;;
    esac
    if [[ -n "$arch" ]]; then
      ext="${XDG_DATA_HOME:-$HOME/.local/share}/gh/extensions/gh-image"
      tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/drogers0/gh-image/releases/latest | sed 's#.*/tag/##')
      mkdir -p "$ext"
      curl -fsSLo "$ext/gh-image" "https://github.com/drogers0/gh-image/releases/download/$tag/linux-$arch"
      chmod 755 "$ext/gh-image"
      printf 'owner: drogers0\nname: gh-image\nhost: github.com\ntag: %s\nispinned: false\npath: %s\n' "$tag" "$ext/gh-image" >"$ext/manifest.yml"
    else
      echo "    no gh-image build for $(uname -m); skipping"
    fi
  fi
fi

step "npm ci (installs the pre-commit hook, builds the client and the server)"
npm ci --no-audit --no-fund

step "Ready"
echo "    node $(node -v), npm $(npm -v)"
echo "    $(git --version)"
command -v gh >/dev/null 2>&1 && echo "    $(gh --version | head -1)"
gh image --version 2>/dev/null | sed 's/^/    /' || true
command -v droid >/dev/null 2>&1 && echo "    droid $(droid --version 2>/dev/null | head -1)"
echo "    agent-browser $(agent-browser --version 2>/dev/null | awk '{print $NF}'), playwright $(playwright --version 2>/dev/null | awk '{print $NF}')"
echo "    $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"
echo "    Check it with: npm run lint && npm run typecheck && npm test"
