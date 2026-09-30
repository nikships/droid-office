#!/usr/bin/env bash
# Required host shader checks: strict compilation, generated GLSL contracts, every stage and
# program through glslangValidator, and pixels against the original three.js office materials.
#
#   bash native/android/app/src/test/cpp/shaders/check.sh [out-dir]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cpp="${OFFICE_XR_SOURCE:-$(cd "$here/../../../main/cpp" && pwd -P)}"
out="${1:-${OFFICE_XR_TEST_OUT:-${TMPDIR:-/tmp}/office-shaders}}"
ndk="${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/27.2.12479018}"
glslang="${GLSLANG:-glslangValidator}"
cxx="${CXX:-c++}"
flags=(-std=c++17 -g -O1 -UNDEBUG -Wall -Wextra -Wpedantic)
if [ -n "${OFFICE_XR_CXXFLAGS:-}" ]; then
  read -r -a supplied_flags <<<"$OFFICE_XR_CXXFLAGS"
  flags+=("${supplied_flags[@]}")
fi
flags+=(-UNDEBUG -Werror)

command -v "$cxx" >/dev/null 2>&1 || { echo "shader check: missing compiler $cxx" >&2; exit 2; }
command -v "$glslang" >/dev/null 2>&1 || { echo "shader check: missing $glslang; install glslang-tools (Linux) or glslang (Homebrew)" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "shader check: node and npm ci are required for pixel comparison" >&2; exit 2; }
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
# These are outputs owned by this suite. Refresh them so stale generated programs cannot pass.
rm -rf "$out/glsl" "$out/compare"
mkdir -p "$out/glsl"

echo "== host $cxx with strict warnings and suite compiler flags"
"$cxx" "${flags[@]}" -I"$cpp" -c "$cpp/scene_shaders.cpp" -o "$out/scene_shaders.o"
"$cxx" "${flags[@]}" -I"$cpp" "$here/dump.cpp" "$out/scene_shaders.o" -o "$out/dump"

ndkcxx=""
for candidate in "$ndk"/toolchains/llvm/prebuilt/*/bin/aarch64-linux-android29-clang++; do
  [ ! -x "$candidate" ] || { ndkcxx="$candidate"; break; }
done
if [ -n "$ndkcxx" ]; then
  echo "== NDK $(basename "$ndk") aarch64-linux-android29-clang++"
  "$ndkcxx" -std=c++17 -Wall -Wextra -Werror -O2 -I"$cpp" -c "$cpp/scene_shaders.cpp" -o "$out/scene_shaders.android.o"
else
  # The full Android build is required separately in CI; this extra cross-compile is host optional.
  echo "NDK cross-compile not requested: pinned NDK is absent at $ndk"
fi

echo "== dump and contract checks"
"$out/dump" "$out/glsl"

echo "== $glslang (GLSL ES 3.00)"
count=0
bad=0
for f in "$out"/glsl/*.vert "$out"/glsl/*.frag; do
  [ -f "$f" ] || { echo "shader check: no generated stages" >&2; exit 1; }
  count=$((count + 1))
  status=0
  msg="$("$glslang" "$f" 2>&1)" || status=$?
  rest="$(printf '%s\n' "$msg" | grep -v -x -F "$f" | grep -v '^$' || true)"
  if [ "$status" -ne 0 ] || [ -n "$rest" ]; then
    bad=$((bad + 1))
    printf '%s (exit %s)\n%s\n' "$f" "$status" "$rest"
  fi
done
echo "stages $count, with errors or warnings $bad"
[ "$bad" -eq 0 ]

echo "== $glslang -l (link each program: varyings and blocks agree)"
links=0
for v in "$out"/glsl/*.vert; do
  links=$((links + 1))
  f="${v%.vert}.frag"
  status=0
  msg="$("$glslang" -l "$v" "$f" 2>&1)" || status=$?
  rest="$(printf '%s\n' "$msg" | grep -v -x -F "$v" | grep -v -x -F "$f" | grep -v '^$' || true)"
  if [ "$status" -ne 0 ] || [ -n "$rest" ]; then
    bad=$((bad + 1))
    printf '%s (exit %s)\n%s\n' "$v" "$status" "$rest"
  fi
done
echo "programs linked $links, with errors or warnings $bad"
[ "$bad" -eq 0 ]

echo "== required pixels against three.js r186 in headless Chromium"
node "$here/compare.mjs" "$out/compare"
echo "shader checks passed: $count stages, $links programs and required pixel comparison"
