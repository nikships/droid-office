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
add_library(office_xr SHARED office_xr.cpp world_vk.cpp xr_input.cpp bridge_state.cpp xr_performance.cpp)
target_sources(office_xr PRIVATE scene_model.cpp scene_packet.cpp scene_shaders.cpp)
target_sources(office_xr PRIVATE scene_stream.cpp scene_frame.cpp)
target_sources(office_xr PRIVATE controller_model.cpp)
target_include_directories(office_xr PRIVATE "${OFFICE_DEPS}")
# The development APK also needs the same real-time frame budget as a release.
target_compile_options(office_xr PRIVATE -O2)
target_compile_definitions(office_xr PRIVATE XR_USE_PLATFORM_ANDROID XR_USE_GRAPHICS_API_OPENGL_ES XR_USE_GRAPHICS_API_VULKAN)
# Debug-only capture puppet (capture_puppet.h). app/build.gradle turns it on for the debug build type.
option(OFFICE_CAPTURE_PUPPET "Accept the page's synthetic capture controllers (debug builds only)" OFF)
if(OFFICE_CAPTURE_PUPPET)
    target_compile_definitions(office_xr PRIVATE OFFICE_CAPTURE_PUPPET=1)
endif()
target_link_libraries(office_xr PRIVATE OpenXR::openxr_loader android log vulkan)

# All installed builds render the real office with Vulkan. The test room is debug-only.
option(OFFICE_VULKAN_SPIKE "Build the debug-only Vulkan foveation test room" OFF)
if(OFFICE_VULKAN_SPIKE)
    target_sources(office_xr PRIVATE vk_spike.cpp)
    target_compile_definitions(office_xr PRIVATE OFFICE_VULKAN_SPIKE)
endif()

# Runtime shaders are generated from office materials. Build the pinned NDK's shaderc with
# the matching STL as documented at developer.android.com/ndk/guides/graphics/shader-compilers.
set(OFFICE_SHADERC "${CMAKE_BINARY_DIR}/shaderc")
set(OFFICE_SHADERC_LIB "${OFFICE_SHADERC}/libs/c++_static/${ANDROID_ABI}/libshaderc.a")
add_custom_command(OUTPUT "${OFFICE_SHADERC_LIB}"
    COMMAND "${ANDROID_NDK}/ndk-build" NDK_PROJECT_PATH=.
        "APP_BUILD_SCRIPT=${ANDROID_NDK}/sources/third_party/shaderc/Android.mk"
        APP_STL=c++_static "APP_ABI=${ANDROID_ABI}" APP_PLATFORM=android-29
        "NDK_OUT=${OFFICE_SHADERC}/obj" "NDK_LIBS_OUT=${OFFICE_SHADERC}/libs"
        libshaderc_combined -j4
    WORKING_DIRECTORY "${ANDROID_NDK}/sources/third_party/shaderc"
    VERBATIM)
add_custom_target(office_shaderc_build DEPENDS "${OFFICE_SHADERC_LIB}")
add_library(office_shaderc STATIC IMPORTED)
set_target_properties(office_shaderc PROPERTIES IMPORTED_LOCATION "${OFFICE_SHADERC_LIB}")
add_dependencies(office_shaderc office_shaderc_build)
add_dependencies(office_xr office_shaderc_build)
target_include_directories(office_xr SYSTEM PRIVATE
    "${ANDROID_NDK}/sources/third_party/shaderc/libshaderc/include")
target_link_libraries(office_xr PRIVATE office_shaderc)

# Vulkan Memory Allocator 3.1.0, pinned source and checksum.
set(OFFICE_VMA "${OFFICE_DEPS}/vma")
file(MAKE_DIRECTORY "${OFFICE_VMA}")
file(DOWNLOAD
    "https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator/v3.1.0/include/vk_mem_alloc.h"
    "${OFFICE_VMA}/vk_mem_alloc.h"
    EXPECTED_HASH SHA256=f063056705f2cd0ddd8d9da034f673b09814ca96aa45a958e9e687bf9f3fed15
    TLS_VERIFY ON)
target_include_directories(office_xr SYSTEM PRIVATE "${OFFICE_VMA}")
target_sources(office_xr PRIVATE vk_scene_renderer.cpp vk_shader_compiler.cpp vk_memory.cpp vk_spike_gpu.cpp)

# Small native input and diagnostic pipelines use ahead-of-time SPIR-V.
find_program(OFFICE_GLSLC glslc PATHS "${ANDROID_NDK}/shader-tools/${ANDROID_HOST_TAG}"
             NO_DEFAULT_PATH REQUIRED)
set(OFFICE_SPIKE_SHADERS "${CMAKE_CURRENT_BINARY_DIR}/vk-spike-shaders")
file(MAKE_DIRECTORY "${OFFICE_SPIKE_SHADERS}")
set(spike_spirv "")
foreach(stage room.vert room.frag overlay.vert overlay.frag input.vert input.frag fade.frag)
    set(source "${CMAKE_CURRENT_SOURCE_DIR}/shaders/vk/${stage}")
    set(output "${OFFICE_SPIKE_SHADERS}/${stage}.inc")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${OFFICE_GLSLC}" --target-env=vulkan1.1 -O -Werror -mfmt=c -o "${output}" "${source}"
        DEPENDS "${source}" VERBATIM)
    list(APPEND spike_spirv "${output}")
endforeach()
add_custom_target(office_vk_shaders DEPENDS ${spike_spirv})
add_dependencies(office_xr office_vk_shaders)
target_include_directories(office_xr PRIVATE "${OFFICE_SPIKE_SHADERS}")
