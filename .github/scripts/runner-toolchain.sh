#!/usr/bin/env bash
# Fails with what is missing when the Mac Mini runner isn't the machine this workflow expects.
#
# The release workflow installs nothing: Node, the JDK, the Android SDK, Xcode and the GitHub CLI
# are installed on the runner itself (docs/guide/development.md, "CI on the Mac Mini"). This checks
# that the machine still has what a job needs before that job spends minutes on a build that would
# fail anyway.
#
# Usage: runner-toolchain.sh [node|xcode|java|android|gh]...
# Each job names only the tools it uses, so drift in one toolchain can't fail a job that never
# touches it. With no arguments, everything is checked.
set -euo pipefail

all=(node xcode java android gh)
wants=("$@")
if [ "${#wants[@]}" -eq 0 ]; then
  wants=("${all[@]}")
fi

missing=()

wants_tool() {
  local tool="$1" want
  for want in "${wants[@]}"; do
    [ "$want" = "$tool" ] && return 0
  done
  return 1
}

ok() {
  printf 'ok      %s\n' "$*"
}

need() {
  local describe="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    ok "$describe"
  else
    missing+=("$describe")
  fi
}

if wants_tool node; then
  # A floor, not an exact major: the runner runs Homebrew's `node`, which takes a new major on a
  # routine `brew upgrade`. 22 is the oldest the suite is known to pass on; a newer major that
  # breaks something shows up as failing checks, not as a preflight that blocks every run.
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge 22 ]; then
    ok "Node $(node -v)"
  else
    missing+=("Node 22 or later (found $(node -v 2>/dev/null || echo 'no node') on PATH)")
  fi
fi

if wants_tool xcode; then
  need 'Xcode and the macOS SDK (xcodebuild)' xcodebuild -version
  need 'notarytool (xcrun)' xcrun --find notarytool
  need 'the Apple silicon lipo/vtool tools' lipo -info /bin/ls
fi

if wants_tool java; then
  # One check: a `java` that runs but reports an unexpected version is a failure, not a pass.
  java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1)"
  if [ "$java_major" = 21 ]; then
    ok "JDK 21 ($JAVA_HOME)"
  else
    missing+=("JDK 21, which the Android app builds with (found ${java_major:-unreadable version})")
  fi
fi

if wants_tool android; then
  if [ -d "${ANDROID_HOME:-}/build-tools" ]; then
    ok "the Android SDK ($ANDROID_HOME)"
  else
    missing+=("the Android SDK (ANDROID_HOME is ${ANDROID_HOME:-unset})")
  fi
fi

if wants_tool gh; then
  need 'the GitHub CLI (gh), which the release is published with' gh --version
fi

if [ "${#missing[@]}" -gt 0 ]; then
  printf '\nThe Mac Mini runner is missing:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf '\nSee docs/guide/development.md, "CI on the Mac Mini".\n' >&2
  exit 1
fi
