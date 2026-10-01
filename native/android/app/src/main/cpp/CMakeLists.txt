cmake_minimum_required(VERSION 3.22.1)
project(droid_office_xr LANGUAGES CXX)
find_package(OpenXR REQUIRED CONFIG)
set(OFFICE_DEPS "${CMAKE_BINARY_DIR}/office-deps")
file(MAKE_DIRECTORY "${OFFICE_DEPS}")
if(NOT EXISTS "${OFFICE_DEPS}/json.hpp")
    file(DOWNLOAD
        "https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp"
        "${OFFICE_DEPS}/json.hpp"
        EXPECTED_HASH SHA256=aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
        TLS_VERIFY ON)
endif()
file(MAKE_DIRECTORY "${OFFICE_DEPS}/nlohmann")
configure_file("${OFFICE_DEPS}/json.hpp" "${OFFICE_DEPS}/nlohmann/json.hpp" COPYONLY)
if(NOT EXISTS "${OFFICE_DEPS}/stb_image.h")
    file(DOWNLOAD
        "https://raw.githubusercontent.com/nothings/stb/f58f558c120e9b32c217290b80bad1a0729fbb2c/stb_image.h"
        "${OFFICE_DEPS}/stb_image.h"
        EXPECTED_HASH SHA256=594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
        TLS_VERIFY ON)
endif()
add_library(office_xr SHARED office_xr.cpp xr_input.cpp bridge_state.cpp input_renderer.cpp cursor_swapchain.cpp xr_performance.cpp)
target_sources(office_xr PRIVATE panel_cutout.cpp)
target_sources(office_xr PRIVATE scene_renderer.cpp scene_model.cpp scene_packet.cpp scene_shaders.cpp)
target_sources(office_xr PRIVATE controller_model.cpp controller_renderer.cpp)
target_include_directories(office_xr PRIVATE "${OFFICE_DEPS}")
# The development APK also needs the same real-time frame budget as a release.
target_compile_options(office_xr PRIVATE -O2)
target_compile_definitions(office_xr PRIVATE XR_USE_PLATFORM_ANDROID XR_USE_GRAPHICS_API_OPENGL_ES)
# Debug-only capture puppet (capture_puppet.h). app/build.gradle turns it on for the debug build type.
option(OFFICE_CAPTURE_PUPPET "Accept the page's synthetic capture controllers (debug builds only)" OFF)
if(OFFICE_CAPTURE_PUPPET)
    target_compile_definitions(office_xr PRIVATE OFFICE_CAPTURE_PUPPET=1)
endif()
target_link_libraries(office_xr PRIVATE OpenXR::openxr_loader android log EGL GLESv3)
