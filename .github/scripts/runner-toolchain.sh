#!/usr/bin/env bash
# Fails with what is missing when the Mac Mini runner isn't the machine this workflow expects.
#
# The release workflow installs nothing: Node, the JDK, the Android SDK and Xcode are installed on
# the runner itself (docs/guide/development.md, "CI on the Mac Mini"). This checks that the machine
# still has them before a job spends minutes on a build that would fail anyway.
set -euo pipefail

missing=()

need() {
  local describe="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "ok      $describe"
  else
    missing+=("$describe")
  fi
}

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
# Exactly the major the runner's Homebrew `node` is. Any other major is a failure rather than a
# silently different runtime: an upgrade to it is a deliberate change, made here at the same time.
if [ "$node_major" = 26 ]; then
  echo "ok      Node $(node -v)"
else
  missing+=("Node 26, the version CI runs (found $(node -v 2>/dev/null || echo 'no node') on PATH)")
fi

need 'Xcode and the macOS SDK (xcodebuild)' xcodebuild -version
need 'notarytool (xcrun)' xcrun --find notarytool
need 'JDK 21 ($JAVA_HOME)' java -version
need 'the Android SDK ($ANDROID_HOME)' test -d "$ANDROID_HOME/build-tools"
need 'the Apple silicon lipo/vtool tools' lipo -info /bin/ls

java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1)"
if [ -n "$java_major" ] && [ "$java_major" != 21 ]; then
  missing+=("JDK 21 is what the Android app builds with (found $java_major)")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  printf '\nThe Mac Mini runner is missing:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf '\nSee docs/guide/development.md, "CI on the Mac Mini".\n' >&2
  exit 1
fi
