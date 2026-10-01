// Vulkan Memory Allocator 3.1.0 (vk_mem_alloc.h, pinned by SHA-256 in CMakeLists.txt and the host
// suite) with the one configuration every translation unit sees; vk_memory.cpp holds its
// implementation. The Vulkan scene renderer suballocates its thousands of geometry buffers and
// textures through it instead of one VkDeviceMemory each, which would pass
// maxMemoryAllocationCount (research/vulkan-port.md 4.5).
//
// Core Vulkan 1.1 entry points, linked from libvulkan (Android exports 1.1 from API level 28; the
// app's minimum is 29): no function pointers are fetched at runtime.
#pragma once

#define VMA_STATIC_VULKAN_FUNCTIONS 1
#define VMA_DYNAMIC_VULKAN_FUNCTIONS 0
#define VMA_VULKAN_VERSION 1001000

#include <vk_mem_alloc.h>
