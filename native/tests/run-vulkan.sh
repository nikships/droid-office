#!/usr/bin/env bash
# Required Vulkan scene check on Linux with Mesa lavapipe and Khronos validation layers.
# Registered by native/tests/run-host.sh on Linux; standalone runs reuse its pinned headers.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
src="${OFFICE_XR_SOURCE:-$root/native/android/app/src/main/cpp}"
test="$root/native/android/app/src/test/cpp/vk"
base="$root/native/android/build/host-tests/out"
out="${OFFICE_XR_TEST_OUT:-$base/vulkan}"
mkdir -p "$out/deps"
vma="$out/deps/vk_mem_alloc.h"
if [ ! -f "$vma" ]; then
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator/v3.1.0/include/vk_mem_alloc.h -o "$vma"
fi
printf '%s  %s\n' f063056705f2cd0ddd8d9da034f673b09814ca96aa45a958e9e687bf9f3fed15 "$vma" | sha256sum --check --status
cxx="${CXX:-c++}"
flags=(-std=c++17 -g -O1 -UNDEBUG -Wall -Wextra -Werror -pthread)
if [ -n "${OFFICE_XR_CXXFLAGS:-}" ]; then
  read -r -a supplied_flags <<<"$OFFICE_XR_CXXFLAGS"
  flags+=("${supplied_flags[@]}")
fi
"$cxx" "${flags[@]}" \
  -I "$src" -isystem "$out/deps" -isystem "${OFFICE_XR_JSON_INCLUDE:-$base/deps/json}" \
  -isystem "${OFFICE_XR_STB_INCLUDE:-$base/deps/stb}" \
  -isystem "${OFFICE_XR_OPENXR_INCLUDE:-$base/deps/openxr/prefab/modules/headers/include}" \
  "$test/render.cpp" "$src/vk_scene_renderer.cpp" "$src/vk_shader_compiler.cpp" "$src/vk_memory.cpp" \
  "$src/scene_frame.cpp" "$src/scene_stream.cpp" "$src/scene_model.cpp" "$src/scene_packet.cpp" "$src/scene_shaders.cpp" \
  -lvulkan -Wl,--start-group -lshaderc_combined -lglslang -lMachineIndependent -lGenericCodeGen \
  -lOSDependent -lSPIRV -lSPIRV-Tools-opt -lSPIRV-Tools -Wl,--end-group -o "$out/render"
"$cxx" -std=c++17 -O2 -Wall -Wextra -Werror "$test/compare.cpp" -o "$out/compare"
fixture="$base/suites/native_android_app_src_test_cpp_run.sh/packets.json"
if [ -n "${OFFICE_XR_TEST_OUT:-}" ]; then
  fixture="$(dirname "$out")/native_android_app_src_test_cpp_run.sh/packets.json"
fi
[ -f "$fixture" ] || { echo "Vulkan check: run the registered scene suite first ($fixture is missing)" >&2; exit 2; }
for samples in 1 4; do
  # Mesa retains process-global allocations. Keep ASan/UBSan, excluding driver leak reports.
  ASAN_OPTIONS="${ASAN_OPTIONS:-}:detect_leaks=0" \
    "$out/render" "$fixture" "$out" --size 640 --seconds 5 --samples "$samples" --name "vk-$samples"
done
echo 'Real-office Vulkan render and Khronos validation checks passed'
