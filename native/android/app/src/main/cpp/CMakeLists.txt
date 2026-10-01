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
target_sources(office_xr PRIVATE foveation_overlay.cpp foveation_filter.cpp)
target_sources(office_xr PRIVATE scene_renderer.cpp scene_model.cpp scene_packet.cpp scene_shaders.cpp)
target_sources(office_xr PRIVATE controller_model.cpp controller_renderer.cpp)
target_include_directories(office_xr PRIVATE "${OFFICE_DEPS}")
# The development APK also needs the same real-time frame budget as a release.
target_compile_options(office_xr PRIVATE -O2)
target_compile_definitions(office_xr PRIVATE XR_USE_PLATFORM_ANDROID XR_USE_GRAPHICS_API_OPENGL_ES)
target_link_libraries(office_xr PRIVATE OpenXR::openxr_loader android log EGL GLESv3)

# Debug builds only (app/build.gradle): the Vulkan eye-tracked foveation spike, selected at launch
# with `--es xr_renderer vulkan-spike`. Release builds keep the GLES renderer alone.
option(OFFICE_VULKAN_SPIKE "Build the debug-only Vulkan foveation spike" OFF)
if(OFFICE_VULKAN_SPIKE)
    # Ahead-of-time SPIR-V with the NDK's own glslc ("Vulkan shader compilers on Android": NDK
    # r12+ ships glslc in <ndk>/shader-tools/). -mfmt=c emits a C initializer list.
    find_program(OFFICE_GLSLC glslc PATHS "${ANDROID_NDK}/shader-tools/${ANDROID_HOST_TAG}"
                 NO_DEFAULT_PATH REQUIRED)
    set(OFFICE_SPIKE_SHADERS "${CMAKE_CURRENT_BINARY_DIR}/vk-spike-shaders")
    file(MAKE_DIRECTORY "${OFFICE_SPIKE_SHADERS}")
    set(spike_spirv "")
    foreach(stage room.vert room.frag overlay.vert overlay.frag)
        set(source "${CMAKE_CURRENT_SOURCE_DIR}/shaders/vk/${stage}")
        set(output "${OFFICE_SPIKE_SHADERS}/${stage}.inc")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${OFFICE_GLSLC}" --target-env=vulkan1.1 -O -Werror -mfmt=c -o "${output}" "${source}"
            DEPENDS "${source}" VERBATIM)
        list(APPEND spike_spirv "${output}")
    endforeach()
    add_custom_target(office_vk_spike_shaders DEPENDS ${spike_spirv})
    add_dependencies(office_xr office_vk_spike_shaders)
    set(spike_sources vk_spike.cpp vk_spike_gpu.cpp)
    target_sources(office_xr PRIVATE ${spike_sources})
    # Only these files see the Vulkan half of openxr_platform.h; the GLES files compile as before.
    set_source_files_properties(${spike_sources} PROPERTIES COMPILE_DEFINITIONS XR_USE_GRAPHICS_API_VULKAN)
    target_include_directories(office_xr PRIVATE "${OFFICE_SPIKE_SHADERS}")
    target_compile_definitions(office_xr PRIVATE OFFICE_VULKAN_SPIKE)
    target_link_libraries(office_xr PRIVATE vulkan)
endif()
