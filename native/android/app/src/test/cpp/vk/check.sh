#!/usr/bin/env bash
# Required host check for the shipping Vulkan input shaders and debug foveation room
# (native/android/app/src/main/cpp/shaders/vk): every stage compiles to Vulkan 1.1 SPIR-V with
# glslangValidator, spirv-val accepts it, and all stages declare the same Frame block that
# office::spike::FrameUniforms mirrors. The APK build compiles the same files with the NDK's glslc.
#
#   bash native/android/app/src/test/cpp/vk/check.sh [out-dir]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cpp="${OFFICE_XR_SOURCE:-$(cd "$here/../../../main/cpp" && pwd -P)}"
shaders="$cpp/shaders/vk"
out="${1:-${OFFICE_XR_TEST_OUT:-${TMPDIR:-/tmp}/office-vk-shaders}}"
ndk="${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/27.2.12479018}"
glslang="${GLSLANG:-glslangValidator}"

command -v "$glslang" >/dev/null 2>&1 || {
  echo "vk shader check: missing $glslang; install glslang-tools (Linux) or glslang (Homebrew)" >&2
  exit 2
}
# spirv-val from the pinned NDK (shader-tools), else from PATH (spirv-tools).
validator=""
for candidate in "$ndk"/shader-tools/*/spirv-val; do
  [ ! -x "$candidate" ] || { validator="$candidate"; break; }
done
if [ -z "$validator" ] && command -v spirv-val >/dev/null 2>&1; then
  validator="$(command -v spirv-val)"
fi
[ -n "$validator" ] || {
  echo "vk shader check: spirv-val not found in $ndk/shader-tools or PATH (install spirv-tools)" >&2
  exit 2
}
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
rm -rf "$out/spv"
mkdir -p "$out/spv"

stages=(room.vert room.frag overlay.vert overlay.frag input.vert input.frag fade.frag)
count=0
for stage in "${stages[@]}"; do
  src="$shaders/$stage"
  [ -f "$src" ] || { echo "vk shader check: $src is missing" >&2; exit 1; }
  spv="$out/spv/$stage.spv"
  status=0
  msg="$("$glslang" -V --target-env vulkan1.1 -o "$spv" "$src" 2>&1)" || status=$?
  rest="$(printf '%s\n' "$msg" | grep -v -x -F "$src" | grep -v '^$' || true)"
  if [ "$status" -ne 0 ] || [ -n "$rest" ]; then
    printf '%s (exit %s)\n%s\n' "$src" "$status" "$rest"
    exit 1
  fi
  "$validator" --target-env vulkan1.1 "$spv"
  count=$((count + 1))
done

for program in room overlay input fade; do
  vertex="$program.vert"
  [ "$program" != fade ] || vertex=overlay.vert
  "$glslang" -V --target-env vulkan1.1 -l -o "$out/spv/$program.link.spv" \
    "$shaders/$vertex" "$shaders/$program.frag"
  "$validator" --target-env vulkan1.1 "$out/spv/$program.link.spv"
done

# The Frame block is the same in every stage that declares it (comments and spacing aside).
reference=""
for stage in "${stages[@]}"; do
  block="$(awk '/uniform Frame \{/{p=1} p{print} p&&/^}/{exit}' "$shaders/$stage" |
    sed -e 's#//.*##' -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' | grep -v '^$' || true)"
  [ -n "$block" ] || continue
  if [ -z "$reference" ]; then
    reference="$block"
  elif [ "$block" != "$reference" ]; then
    echo "vk shader check: $stage declares a different Frame block" >&2
    exit 1
  fi
done
[ -n "$reference" ] || { echo "vk shader check: no Frame block found" >&2; exit 1; }
echo "vk shaders: $count stages and 4 programs compiled, linked ($("$glslang" --version | head -n 1)) and validated by $(basename "$validator")"
