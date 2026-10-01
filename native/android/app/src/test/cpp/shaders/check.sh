#!/usr/bin/env bash
# Required host shader checks: strict compilation, generated GLSL contracts, every stage and
# program through glslangValidator, the GLES text against its golden hash, every program in the
# Vulkan dialect through glslc, spirv-val and glslang's Vulkan link, and pixels against the
# original three.js office materials.
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
# The Vulkan dialect's compiler and validator: the pinned NDK's shader-tools (glslc is the shaderc
# the Vulkan renderer embeds), else PATH (glslc and spirv-tools on Linux, shaderc on Homebrew).
tool() {
  local candidate
  for candidate in "$ndk"/shader-tools/*/"$1"; do
    [ ! -x "$candidate" ] || { printf '%s\n' "$candidate"; return; }
  done
  command -v "$1" 2>/dev/null || true
}
glslc="$(tool glslc)"
spirv_val="$(tool spirv-val)"
[ -n "$glslc" ] || { echo "shader check: glslc not found in $ndk/shader-tools or PATH (install glslc or shaderc)" >&2; exit 2; }
[ -n "$spirv_val" ] || { echo "shader check: spirv-val not found in $ndk/shader-tools or PATH (install spirv-tools)" >&2; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then sha256=(sha256sum); else sha256=(shasum -a 256); fi
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
# These are outputs owned by this suite. Refresh them so stale generated programs cannot pass.
rm -rf "$out/glsl" "$out/vk" "$out/compare"
mkdir -p "$out/glsl" "$out/vk"

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

echo "== dump and contract checks (GLES and the Vulkan dialect)"
"$out/dump" "$out/glsl" "$out/vk"

# The shipping GLES text is byte for byte what the Vulkan port started from
# (research/vulkan-port.md 4.5). A deliberate GLES shader change updates gles-dump.sha256 in the
# same commit, with the new hash this step prints.
echo "== GLES text against its golden hash"
gles_hash="$(cd "$out/glsl" && LC_ALL=C ls | LC_ALL=C sort | while read -r f; do cat "$f"; done | "${sha256[@]}" | cut -d' ' -f1)"
golden="$(tr -d '[:space:]' <"$here/gles-dump.sha256")"
if [ "$gles_hash" != "$golden" ]; then
  echo "shader check: the GLES dump hashes to $gles_hash, gles-dump.sha256 has $golden" >&2
  exit 1
fi
echo "GLES dump $gles_hash"

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

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
echo "== Vulkan dialect: $(basename "$glslc") ($("$glslc" --version | head -n 1)), $(basename "$spirv_val") and $glslang -V -l, Vulkan 1.1, $jobs jobs"
vk_links=0
for v in "$out"/vk/*.vert; do
  [ -f "$v" ] && [ -f "${v%.vert}.frag" ] || { echo "shader check: no Vulkan dialect program at $v" >&2; exit 1; }
  vk_links=$((vk_links + 1))
done
vk_stages=$((vk_links * 2))
status=0
find "$out/vk" -name '*.vert' | LC_ALL=C sort | sed 's/\.vert$//' |
  GLSLC="$glslc" SPIRV_VAL="$spirv_val" GLSLANG="$glslang" OFFSETS="$out/vk/draw-offsets.txt" \
    xargs -P "$jobs" -n 16 bash "$here/vulkan-stages.sh" || status=$?
[ "$status" -eq 0 ] || { echo "shader check: Vulkan dialect programs failed (status $status)" >&2; exit 1; }
echo "Vulkan stages $vk_stages compiled and validated; programs $vk_links linked and reflected against DrawBlock"

echo "== required pixels against three.js r186 in headless Chromium"
node "$here/compare.mjs" "$out/compare"
echo "shader checks passed: $count stages, $links programs, $vk_stages Vulkan stages, $vk_links Vulkan programs and required pixel comparison"
