#!/usr/bin/env bash
# Required real-office packet/model/replay and GLES framebuffer checks. No silent GL skip.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
src="${OFFICE_XR_SOURCE:?run through native/tests/run-host.sh}"
out="${OFFICE_XR_TEST_OUT:?run through native/tests/run-host.sh}"
read -r -a flags <<< "${OFFICE_XR_CXXFLAGS:?missing compiler flags}"
cxx="${CXX:-c++}"
includes=(-I "$src" -I "$OFFICE_XR_JSON_INCLUDE" -I "$OFFICE_XR_STB_INCLUDE")
core=("$src/scene_packet.cpp" "$src/scene_model.cpp" "$src/scene_shaders.cpp")
node --import tsx "$here/fixture.mts" "$out/packets.json"
for suite in unit replay; do
  "$cxx" "${flags[@]}" "${includes[@]}" "$here/$suite.cpp" "${core[@]}" -o "$out/$suite"
  "$out/$suite" "$out/packets.json"
done
# Linux uses system Mesa EGL/GLES (surfaceless software rendering in CI). macOS needs
# externally installed EGL/GLES libraries and headers; missing dependencies fail the check.
gl_includes=() gl_links=(-lEGL -lGLESv2)
if [ -n "${GL_HEADERS:-}" ]; then gl_includes=(-I "$GL_HEADERS"); fi
if [ -n "${ANGLE_LIB:-}" ]; then gl_links=(-L "$ANGLE_LIB" -lEGL -lGLESv2 -Wl,-rpath,"$ANGLE_LIB"); fi
"$cxx" "${flags[@]}" "${includes[@]}" -I "${OFFICE_XR_OPENXR_INCLUDE:?run through native/tests/run-host.sh}" \
  ${gl_includes[@]+"${gl_includes[@]}"} -DGL_GLEXT_PROTOTYPES "$here/render.cpp" "${core[@]}" \
  "$src/scene_renderer.cpp" "$src/panel_cutout.cpp" "${gl_links[@]}" -o "$out/render"
# Software GL drivers retain process-global allocations. Memory and undefined behavior
# checks remain enabled; leak reporting is disabled only for this driver-backed process.
ASAN_OPTIONS="${ASAN_OPTIONS:-}:detect_leaks=0" EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1 \
  "$out/render" "$out/packets.json" "$out" --size 640 --seconds 5
echo 'Scene packet/model, real-office replay and GLES framebuffer/render checks passed'
