#include "vk_spike_gpu.h"
#include "xr_util.h"
#include <algorithm>
#include <android/log.h>
#include <cstddef>
#include <cstring>
#include <stdexcept>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeXR", __VA_ARGS__)

// Every call and structure below follows one of these working or normative sources (local copies
// under the spike's research/ directory unless a URL is given):
//  [XR-VK2]  OpenXR XR_KHR_vulkan_enable2 (khr_vulkan_enable2.adoc): concurrency, image layouts.
//  [XR-FBV]  OpenXR XR_FB_foveation_vulkan (fb_foveation_vulkan.adoc).
//  [GD-VKX]  Godot modules/openxr/extensions/platform/openxr_vulkan_extension.cpp @084a2ca.
//  [GD-RDV]  Godot drivers/vulkan/rendering_device_driver_vulkan.cpp @084a2ca.
//  [GD-RD]   Godot servers/rendering/rendering_device.cpp @084a2ca (FDM attachment description).
//  [HXR]     Khronos hello_xr graphicsplugin_vulkan.cpp (OpenXR-SDK-Source release-1.1.49).
//  [VK-FDM]  Vulkan VkRenderPassFragmentDensityMapCreateInfoEXT and Fetch Density Value
//            (https://docs.vulkan.org/spec/latest/chapters/fragmentdensitymapops.html).
//  [VK-FDMO] VkRenderPassFragmentDensityMapOffsetEndInfoEXT, the alias of
//            VkSubpassFragmentDensityMapOffsetEndInfoQCOM (docs.vulkan.org refpages).
//  [NDK-DN]  Android "Vulkan design guidelines" (transient attachments, memory types).

namespace office::spike {
namespace {
const uint32_t roomVert[] =
#include "room.vert.inc"
    ;
const uint32_t roomFrag[] =
#include "room.frag.inc"
    ;
const uint32_t overlayVert[] =
#include "overlay.vert.inc"
    ;
const uint32_t overlayFrag[] =
#include "overlay.frag.inc"
    ;

template <class T> T vkStruct(VkStructureType type) {
    T value{};
    value.sType = type;
    return value;
}
void vk(VkResult result, const char *operation) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": VkResult " + std::to_string(result));
}
void xr(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}
template <class T> T xrFunction(XrInstance instance, const char *name) {
    PFN_xrVoidFunction value = nullptr;
    xr(xrGetInstanceProcAddr(instance, name, &value), name);
    return reinterpret_cast<T>(value);
}
uint32_t vkFromXr(XrVersion version) {
    return VK_MAKE_API_VERSION(0, XR_VERSION_MAJOR(version), XR_VERSION_MINOR(version), 0);
}
std::string versionText(uint32_t version) {
    return std::to_string(VK_API_VERSION_MAJOR(version)) + "." +
           std::to_string(VK_API_VERSION_MINOR(version)) + "." +
           std::to_string(VK_API_VERSION_PATCH(version));
}
} // namespace

nlohmann::json DeviceCaps::json() const {
    return {
        {"instanceVersion", versionText(instanceVersion)},
        {"deviceVersion", versionText(deviceVersion)},
        {"device", deviceName},
        {"vendorId", vendorId},
        {"deviceId", deviceId},
        {"driverVersion", driverVersion},
        {"xrVulkanMin", std::to_string(XR_VERSION_MAJOR(xrMinVersion)) + "." +
                            std::to_string(XR_VERSION_MINOR(xrMinVersion))},
        {"xrVulkanMax", std::to_string(XR_VERSION_MAJOR(xrMaxVersion)) + "." +
                            std::to_string(XR_VERSION_MINOR(xrMaxVersion))},
        {"VK_EXT_fragment_density_map", fdmExtension},
        {"VK_QCOM_fragment_density_map_offset", fdmOffsetExtension},
        {"VK_EXT_multisampled_render_to_single_sampled", msrtssExtension},
        {"renderPass2", renderPass2Core        ? "core"
                        : renderPass2Extension ? "KHR"
                                               : "none"},
        {"multiview", multiview},
        {"maxMultiviewViewCount", maxMultiviewViewCount},
        {"fragmentDensityMap", fragmentDensityMap},
        {"fragmentDensityMapDynamic", fragmentDensityMapDynamic},
        {"fragmentDensityMapNonSubsampledImages", fragmentDensityMapNonSubsampledImages},
        {"fragmentDensityMapOffset", fragmentDensityMapOffset},
        {"multisampledRenderToSingleSampled", multisampledRenderToSingleSampled},
        {"minFragmentDensityTexelSize", {minTexel.width, minTexel.height}},
        {"maxFragmentDensityTexelSize", {maxTexel.width, maxTexel.height}},
        {"fragmentDensityInvocations", densityInvocations},
        {"fragmentDensityOffsetGranularity", {offsetGranularity.width, offsetGranularity.height}},
        {"lazilyAllocatedMemory", lazilyAllocated},
        {"timestampValidBits", timestampValidBits},
        {"timestampPeriod", timestampPeriod},
        {"colorSampleCounts", colorSamples},
        {"depthSampleCounts", depthSamples},
        {"depthFormat", depthFormat},
        {"queueFamily", queueFamily},
        {"instanceLayers", instanceLayers}};
}

Gpu::~Gpu() {
    destroyWorld();
    destroyDevice();
}

void Gpu::createDevice(XrInstance xrInstance, XrSystemId system, bool wantRenderToSingle) {
    // [GD-VKX] check_graphics_api_support: requirements first, then compare the version.
    auto requirements = office::structure<XrGraphicsRequirementsVulkan2KHR>(
        XR_TYPE_GRAPHICS_REQUIREMENTS_VULKAN2_KHR);
    xr(xrFunction<PFN_xrGetVulkanGraphicsRequirements2KHR>(
           xrInstance, "xrGetVulkanGraphicsRequirements2KHR")(xrInstance, system, &requirements),
       "xrGetVulkanGraphicsRequirements2KHR");
    deviceCaps.xrMinVersion = requirements.minApiVersionSupported;
    deviceCaps.xrMaxVersion = requirements.maxApiVersionSupported;
    uint32_t loader = VK_API_VERSION_1_0;
    vk(vkEnumerateInstanceVersion(&loader), "vkEnumerateInstanceVersion");
    // Vulkan 1.2 makes vkCreateRenderPass2/vkCmdEndRenderPass2 core; VK_QCOM offsets need them.
    uint32_t want = std::min(loader, static_cast<uint32_t>(VK_API_VERSION_1_3));
    const uint32_t xrMax = vkFromXr(requirements.maxApiVersionSupported);
    if (want > xrMax && xrMax >= VK_API_VERSION_1_1)
        want = xrMax;
    if (want < VK_API_VERSION_1_1 || want < vkFromXr(requirements.minApiVersionSupported))
        throw std::runtime_error("Vulkan " + versionText(want) +
                                 " is below the spike's 1.1 or the runtime minimum");
    deviceCaps.instanceVersion = want;

    uint32_t layerCount = 0;
    vkEnumerateInstanceLayerProperties(&layerCount, nullptr);
    std::vector<VkLayerProperties> layers(layerCount);
    vkEnumerateInstanceLayerProperties(&layerCount, layers.data());
    for (const auto &layer : layers)
        deviceCaps.instanceLayers.emplace_back(layer.layerName);

    auto app = vkStruct<VkApplicationInfo>(VK_STRUCTURE_TYPE_APPLICATION_INFO);
    app.pApplicationName = "Droid Office XR Vulkan spike";
    app.applicationVersion = 1;
    app.pEngineName = "Office native";
    app.apiVersion = want;
    auto instanceInfo = vkStruct<VkInstanceCreateInfo>(VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO);
    instanceInfo.pApplicationInfo = &app;
    // [GD-VKX] create_vulkan_instance; [HXR] InitializeDevice.
    auto xrInstanceInfo =
        office::structure<XrVulkanInstanceCreateInfoKHR>(XR_TYPE_VULKAN_INSTANCE_CREATE_INFO_KHR);
    xrInstanceInfo.systemId = system;
    xrInstanceInfo.createFlags = 0;
    xrInstanceInfo.pfnGetInstanceProcAddr = vkGetInstanceProcAddr;
    xrInstanceInfo.vulkanCreateInfo = &instanceInfo;
    VkResult vkResult = VK_SUCCESS;
    xr(xrFunction<PFN_xrCreateVulkanInstanceKHR>(xrInstance, "xrCreateVulkanInstanceKHR")(
           xrInstance, &xrInstanceInfo, &instance, &vkResult),
       "xrCreateVulkanInstanceKHR");
    vk(vkResult, "vkCreateInstance through the runtime");

    // [GD-VKX] get_physical_device: the runtime chooses the device; never enumerate it.
    auto deviceGet = office::structure<XrVulkanGraphicsDeviceGetInfoKHR>(
        XR_TYPE_VULKAN_GRAPHICS_DEVICE_GET_INFO_KHR);
    deviceGet.systemId = system;
    deviceGet.vulkanInstance = instance;
    xr(xrFunction<PFN_xrGetVulkanGraphicsDevice2KHR>(xrInstance, "xrGetVulkanGraphicsDevice2KHR")(
           xrInstance, &deviceGet, &physical),
       "xrGetVulkanGraphicsDevice2KHR");

    VkPhysicalDeviceProperties properties{};
    vkGetPhysicalDeviceProperties(physical, &properties);
    deviceCaps.deviceName = properties.deviceName;
    deviceCaps.vendorId = properties.vendorID;
    deviceCaps.deviceId = properties.deviceID;
    deviceCaps.driverVersion = properties.driverVersion;
    deviceCaps.deviceVersion = std::min(properties.apiVersion, want);
    deviceCaps.timestampPeriod = properties.limits.timestampPeriod;
    deviceCaps.colorSamples = properties.limits.framebufferColorSampleCounts;
    deviceCaps.depthSamples = properties.limits.framebufferDepthSampleCounts;

    uint32_t extensionCount = 0;
    vkEnumerateDeviceExtensionProperties(physical, nullptr, &extensionCount, nullptr);
    std::vector<VkExtensionProperties> extensions(extensionCount);
    vkEnumerateDeviceExtensionProperties(physical, nullptr, &extensionCount, extensions.data());
    auto has = [&](const char *name) {
        return std::any_of(extensions.begin(), extensions.end(),
                           [&](const auto &e) { return !strcmp(e.extensionName, name); });
    };
    deviceCaps.fdmExtension = has(VK_EXT_FRAGMENT_DENSITY_MAP_EXTENSION_NAME);
    deviceCaps.fdmOffsetExtension = has(VK_QCOM_FRAGMENT_DENSITY_MAP_OFFSET_EXTENSION_NAME);
    deviceCaps.msrtssExtension = has(VK_EXT_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_EXTENSION_NAME);
    deviceCaps.renderPass2Core = deviceCaps.deviceVersion >= VK_API_VERSION_1_2;
    deviceCaps.renderPass2Extension = has(VK_KHR_CREATE_RENDERPASS_2_EXTENSION_NAME);

    // [GD-RDV] _check_device_capabilities: one features2/properties2 query with the chains of
    // the extensions that are present.
    auto multiviewFeatures = vkStruct<VkPhysicalDeviceMultiviewFeatures>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_FEATURES);
    auto fdmFeatures = vkStruct<VkPhysicalDeviceFragmentDensityMapFeaturesEXT>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_FEATURES_EXT);
    auto offsetFeatures = vkStruct<VkPhysicalDeviceFragmentDensityMapOffsetFeaturesQCOM>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_OFFSET_FEATURES_QCOM);
    auto msrtssFeatures = vkStruct<VkPhysicalDeviceMultisampledRenderToSingleSampledFeaturesEXT>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_FEATURES_EXT);
    auto features =
        vkStruct<VkPhysicalDeviceFeatures2>(VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2);
    void *next = &multiviewFeatures;
    if (deviceCaps.fdmExtension) {
        fdmFeatures.pNext = next;
        next = &fdmFeatures;
    }
    if (deviceCaps.fdmOffsetExtension) {
        offsetFeatures.pNext = next;
        next = &offsetFeatures;
    }
    if (deviceCaps.msrtssExtension) {
        msrtssFeatures.pNext = next;
        next = &msrtssFeatures;
    }
    features.pNext = next;
    vkGetPhysicalDeviceFeatures2(physical, &features);
    deviceCaps.multiview = multiviewFeatures.multiview;
    deviceCaps.fragmentDensityMap = deviceCaps.fdmExtension && fdmFeatures.fragmentDensityMap;
    deviceCaps.fragmentDensityMapDynamic =
        deviceCaps.fdmExtension && fdmFeatures.fragmentDensityMapDynamic;
    deviceCaps.fragmentDensityMapNonSubsampledImages =
        deviceCaps.fdmExtension && fdmFeatures.fragmentDensityMapNonSubsampledImages;
    deviceCaps.fragmentDensityMapOffset =
        deviceCaps.fdmOffsetExtension && offsetFeatures.fragmentDensityMapOffset;
    deviceCaps.multisampledRenderToSingleSampled =
        deviceCaps.msrtssExtension && msrtssFeatures.multisampledRenderToSingleSampled;
    if (!deviceCaps.multiview)
        throw std::runtime_error("Vulkan multiview is not supported");

    auto multiviewProperties = vkStruct<VkPhysicalDeviceMultiviewProperties>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_PROPERTIES);
    auto fdmProperties = vkStruct<VkPhysicalDeviceFragmentDensityMapPropertiesEXT>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_PROPERTIES_EXT);
    auto offsetProperties = vkStruct<VkPhysicalDeviceFragmentDensityMapOffsetPropertiesQCOM>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_OFFSET_PROPERTIES_QCOM);
    auto properties2 =
        vkStruct<VkPhysicalDeviceProperties2>(VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2);
    next = &multiviewProperties;
    if (deviceCaps.fdmExtension) {
        fdmProperties.pNext = next;
        next = &fdmProperties;
    }
    if (deviceCaps.fdmOffsetExtension) {
        offsetProperties.pNext = next;
        next = &offsetProperties;
    }
    properties2.pNext = next;
    vkGetPhysicalDeviceProperties2(physical, &properties2);
    deviceCaps.maxMultiviewViewCount = multiviewProperties.maxMultiviewViewCount;
    deviceCaps.minTexel = fdmProperties.minFragmentDensityTexelSize;
    deviceCaps.maxTexel = fdmProperties.maxFragmentDensityTexelSize;
    deviceCaps.densityInvocations = fdmProperties.fragmentDensityInvocations;
    deviceCaps.offsetGranularity = offsetProperties.fragmentDensityOffsetGranularity;

    // [HXR] InitializeDevice: the first queue family with graphics.
    uint32_t familyCount = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &familyCount, nullptr);
    std::vector<VkQueueFamilyProperties> families(familyCount);
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &familyCount, families.data());
    bool found = false;
    for (uint32_t i = 0; i < familyCount && !found; ++i)
        if (families[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) {
            deviceCaps.queueFamily = i;
            deviceCaps.timestampValidBits = families[i].timestampValidBits;
            found = true;
        }
    if (!found)
        throw std::runtime_error("No Vulkan graphics queue family");

    vkGetPhysicalDeviceMemoryProperties(physical, &memory);
    for (uint32_t i = 0; i < memory.memoryTypeCount; ++i)
        if (memory.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT)
            deviceCaps.lazilyAllocated = true;
    // [GD-VKX] get_usable_depth_formats order, plus D16 as a last resort.
    for (VkFormat format :
         {VK_FORMAT_D24_UNORM_S8_UINT, VK_FORMAT_D32_SFLOAT, VK_FORMAT_D16_UNORM}) {
        VkFormatProperties formatProperties{};
        vkGetPhysicalDeviceFormatProperties(physical, format, &formatProperties);
        if (formatProperties.optimalTilingFeatures &
            VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT) {
            deviceCaps.depthFormat = format;
            break;
        }
    }
    if (deviceCaps.depthFormat == VK_FORMAT_UNDEFINED)
        throw std::runtime_error("No Vulkan depth attachment format");

    std::vector<const char *> enabled;
    if (deviceCaps.fdmExtension)
        enabled.push_back(VK_EXT_FRAGMENT_DENSITY_MAP_EXTENSION_NAME);
    if (deviceCaps.fdmOffsetExtension && deviceCaps.fragmentDensityMapOffset)
        enabled.push_back(VK_QCOM_FRAGMENT_DENSITY_MAP_OFFSET_EXTENSION_NAME);
    if (!deviceCaps.renderPass2Core) {
        if (!deviceCaps.renderPass2Extension)
            throw std::runtime_error("Neither Vulkan 1.2 nor VK_KHR_create_renderpass2");
        enabled.push_back(VK_KHR_CREATE_RENDERPASS_2_EXTENSION_NAME);
    }
    renderToSingleEnabled = wantRenderToSingle && deviceCaps.multisampledRenderToSingleSampled;
    if (renderToSingleEnabled)
        enabled.push_back(VK_EXT_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_EXTENSION_NAME);

    // [GD-RDV] L1389-1405: enable the FDM features the device reports and the offset feature.
    auto enableMultiview = vkStruct<VkPhysicalDeviceMultiviewFeatures>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_FEATURES);
    enableMultiview.multiview = VK_TRUE;
    auto enableFdm = vkStruct<VkPhysicalDeviceFragmentDensityMapFeaturesEXT>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_FEATURES_EXT);
    enableFdm.fragmentDensityMap = deviceCaps.fragmentDensityMap;
    enableFdm.fragmentDensityMapNonSubsampledImages =
        deviceCaps.fragmentDensityMapNonSubsampledImages;
    auto enableOffset = vkStruct<VkPhysicalDeviceFragmentDensityMapOffsetFeaturesQCOM>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_DENSITY_MAP_OFFSET_FEATURES_QCOM);
    enableOffset.fragmentDensityMapOffset = VK_TRUE;
    auto enableMsrtss = vkStruct<VkPhysicalDeviceMultisampledRenderToSingleSampledFeaturesEXT>(
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_FEATURES_EXT);
    enableMsrtss.multisampledRenderToSingleSampled = VK_TRUE;
    auto enable = vkStruct<VkPhysicalDeviceFeatures2>(VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2);
    next = &enableMultiview;
    if (deviceCaps.fdmExtension) {
        enableFdm.pNext = next;
        next = &enableFdm;
    }
    offsetFeatureEnabled = deviceCaps.fragmentDensityMapOffset;
    if (offsetFeatureEnabled) {
        enableOffset.pNext = next;
        next = &enableOffset;
    }
    if (renderToSingleEnabled) {
        enableMsrtss.pNext = next;
        next = &enableMsrtss;
    }
    enable.pNext = next;

    const float priority = 0;
    auto queueInfo = vkStruct<VkDeviceQueueCreateInfo>(VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO);
    queueInfo.queueFamilyIndex = deviceCaps.queueFamily;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;
    auto deviceInfo = vkStruct<VkDeviceCreateInfo>(VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO);
    deviceInfo.pNext = &enable;
    deviceInfo.queueCreateInfoCount = 1;
    deviceInfo.pQueueCreateInfos = &queueInfo;
    deviceInfo.enabledExtensionCount = static_cast<uint32_t>(enabled.size());
    deviceInfo.ppEnabledExtensionNames = enabled.data();
    // [GD-VKX] create_vulkan_device; [HXR]. The runtime may add its own device extensions.
    auto xrDeviceInfo =
        office::structure<XrVulkanDeviceCreateInfoKHR>(XR_TYPE_VULKAN_DEVICE_CREATE_INFO_KHR);
    xrDeviceInfo.systemId = system;
    xrDeviceInfo.createFlags = 0;
    xrDeviceInfo.pfnGetInstanceProcAddr = vkGetInstanceProcAddr;
    xrDeviceInfo.vulkanPhysicalDevice = physical;
    xrDeviceInfo.vulkanCreateInfo = &deviceInfo;
    vkResult = VK_SUCCESS;
    xr(xrFunction<PFN_xrCreateVulkanDeviceKHR>(xrInstance, "xrCreateVulkanDeviceKHR")(
           xrInstance, &xrDeviceInfo, &device, &vkResult),
       "xrCreateVulkanDeviceKHR");
    vk(vkResult, "vkCreateDevice through the runtime");
    vkGetDeviceQueue(device, deviceCaps.queueFamily, 0, &queue);
    const char *create =
        deviceCaps.renderPass2Core ? "vkCreateRenderPass2" : "vkCreateRenderPass2KHR";
    const char *end = deviceCaps.renderPass2Core ? "vkCmdEndRenderPass2" : "vkCmdEndRenderPass2KHR";
    createRenderPass2 =
        reinterpret_cast<PFN_vkCreateRenderPass2>(vkGetDeviceProcAddr(device, create));
    endRenderPass2 = reinterpret_cast<PFN_vkCmdEndRenderPass2>(vkGetDeviceProcAddr(device, end));
    if (!createRenderPass2 || !endRenderPass2)
        throw std::runtime_error("Render pass 2 entry points are missing");
}

XrGraphicsBindingVulkanKHR Gpu::binding() const {
    // [GD-VKX] set_session_create_and_get_next_pointer; queue index 0 of the graphics family.
    auto out = office::structure<XrGraphicsBindingVulkanKHR>(XR_TYPE_GRAPHICS_BINDING_VULKAN2_KHR);
    out.instance = instance;
    out.physicalDevice = physical;
    out.device = device;
    out.queueFamilyIndex = deviceCaps.queueFamily;
    out.queueIndex = 0;
    return out;
}

uint32_t Gpu::memoryType(uint32_t allowed, VkMemoryPropertyFlags required,
                         VkMemoryPropertyFlags preferred) const {
    // [NDK-DN] "Choose appropriate memory types": the first allowed type with the properties.
    for (VkMemoryPropertyFlags want : {required | preferred, required})
        for (uint32_t i = 0; i < memory.memoryTypeCount; ++i)
            if ((allowed & (1u << i)) && (memory.memoryTypes[i].propertyFlags & want) == want)
                return i;
    throw std::runtime_error("No Vulkan memory type for the request");
}

VkImageView Gpu::arrayView(VkImage image, VkFormat format, VkImageAspectFlags aspect) {
    auto info = vkStruct<VkImageViewCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO);
    info.image = image;
    // Multiview: both eyes are layers of one 2D array ([GD-VKX] TEXTURE_TYPE_2D_ARRAY).
    info.viewType = VK_IMAGE_VIEW_TYPE_2D_ARRAY;
    info.format = format;
    info.subresourceRange = {aspect, 0, 1, 0, 2};
    VkImageView view = VK_NULL_HANDLE;
    vk(vkCreateImageView(device, &info, nullptr, &view), "vkCreateImageView");
    return view;
}

Gpu::Allocation Gpu::attachment(VkFormat format, VkSampleCountFlagBits samples,
                                VkImageUsageFlags usage, VkImageCreateFlags flags,
                                VkImageAspectFlags aspect) {
    Allocation out;
    auto info = vkStruct<VkImageCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO);
    info.flags = flags;
    info.imageType = VK_IMAGE_TYPE_2D;
    info.format = format;
    info.extent = {world.width, world.height, 1};
    info.mipLevels = 1;
    info.arrayLayers = 2;
    info.samples = samples;
    info.tiling = VK_IMAGE_TILING_OPTIMAL;
    // [NDK-DN]: never loaded or stored, so transient (on-tile only with lazily allocated memory).
    info.usage = usage | VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT;
    info.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    vk(vkCreateImage(device, &info, nullptr, &out.image), "vkCreateImage attachment");
    VkMemoryRequirements requirements{};
    vkGetImageMemoryRequirements(device, out.image, &requirements);
    auto allocate = vkStruct<VkMemoryAllocateInfo>(VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO);
    allocate.allocationSize = requirements.size;
    uint32_t type = UINT32_MAX;
    for (uint32_t i = 0; i < memory.memoryTypeCount && type == UINT32_MAX; ++i)
        if ((requirements.memoryTypeBits & (1u << i)) &&
            (memory.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT))
            type = i;
    allocate.memoryTypeIndex = type != UINT32_MAX ? type
                                                  : memoryType(requirements.memoryTypeBits, 0,
                                                               VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    vk(vkAllocateMemory(device, &allocate, nullptr, &out.memory), "vkAllocateMemory attachment");
    vk(vkBindImageMemory(device, out.image, out.memory, 0), "vkBindImageMemory");
    out.view = arrayView(out.image, format, aspect);
    LOG("VK_ATTACHMENT format=%d samples=%d bytes=%llu lazy=%d flags=0x%x", format, samples,
        static_cast<unsigned long long>(requirements.size), type != UINT32_MAX, flags);
    return out;
}

Gpu::Buffer Gpu::hostBuffer(VkDeviceSize size, VkBufferUsageFlags usage) {
    Buffer out;
    auto info = vkStruct<VkBufferCreateInfo>(VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO);
    info.size = size;
    info.usage = usage;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    vk(vkCreateBuffer(device, &info, nullptr, &out.buffer), "vkCreateBuffer");
    VkMemoryRequirements requirements{};
    vkGetBufferMemoryRequirements(device, out.buffer, &requirements);
    auto allocate = vkStruct<VkMemoryAllocateInfo>(VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO);
    allocate.allocationSize = requirements.size;
    allocate.memoryTypeIndex =
        memoryType(requirements.memoryTypeBits,
                   VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, 0);
    vk(vkAllocateMemory(device, &allocate, nullptr, &out.memory), "vkAllocateMemory buffer");
    vk(vkBindBufferMemory(device, out.buffer, out.memory, 0), "vkBindBufferMemory");
    vk(vkMapMemory(device, out.memory, 0, VK_WHOLE_SIZE, 0, &out.mapped), "vkMapMemory");
    return out;
}

void Gpu::destroy(Allocation &allocation) {
    if (allocation.view)
        vkDestroyImageView(device, allocation.view, nullptr);
    if (allocation.image)
        vkDestroyImage(device, allocation.image, nullptr);
    if (allocation.memory)
        vkFreeMemory(device, allocation.memory, nullptr);
    allocation = {};
}

void Gpu::destroy(Buffer &buffer) {
    if (buffer.buffer)
        vkDestroyBuffer(device, buffer.buffer, nullptr);
    if (buffer.memory)
        vkFreeMemory(device, buffer.memory, nullptr);
    buffer = {};
}

VkPipeline Gpu::pipeline(const uint32_t *vertexCode, size_t vertexBytes,
                         const uint32_t *fragmentCode, size_t fragmentBytes, bool room,
                         VkSampleCountFlagBits samples) {
    VkShaderModule modules[2]{};
    const uint32_t *code[2]{vertexCode, fragmentCode};
    const size_t bytes[2]{vertexBytes, fragmentBytes};
    for (int i = 0; i < 2; ++i) {
        auto info = vkStruct<VkShaderModuleCreateInfo>(VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO);
        info.codeSize = bytes[i];
        info.pCode = code[i];
        vk(vkCreateShaderModule(device, &info, nullptr, &modules[i]), "vkCreateShaderModule");
    }
    VkPipelineShaderStageCreateInfo stages[2]{};
    for (int i = 0; i < 2; ++i) {
        stages[i].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        stages[i].stage = i ? VK_SHADER_STAGE_FRAGMENT_BIT : VK_SHADER_STAGE_VERTEX_BIT;
        stages[i].module = modules[i];
        stages[i].pName = "main";
    }
    VkVertexInputBindingDescription binding{0, sizeof(RoomVertex), VK_VERTEX_INPUT_RATE_VERTEX};
    VkVertexInputAttributeDescription attributes[3]{
        {0, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(RoomVertex, position)},
        {1, 0, VK_FORMAT_R32G32B32_SFLOAT, offsetof(RoomVertex, normal)},
        {2, 0, VK_FORMAT_R32_SFLOAT, offsetof(RoomVertex, material)}};
    auto vertexInput = vkStruct<VkPipelineVertexInputStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO);
    if (room) {
        vertexInput.vertexBindingDescriptionCount = 1;
        vertexInput.pVertexBindingDescriptions = &binding;
        vertexInput.vertexAttributeDescriptionCount = 3;
        vertexInput.pVertexAttributeDescriptions = attributes;
    }
    auto assembly = vkStruct<VkPipelineInputAssemblyStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO);
    assembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    auto viewport = vkStruct<VkPipelineViewportStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO);
    viewport.viewportCount = 1;
    viewport.scissorCount = 1;
    auto raster = vkStruct<VkPipelineRasterizationStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO);
    raster.polygonMode = VK_POLYGON_MODE_FILL;
    // The room is seen from inside and the cubes from outside: no culling in the spike.
    raster.cullMode = VK_CULL_MODE_NONE;
    raster.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
    raster.lineWidth = 1;
    auto multisample = vkStruct<VkPipelineMultisampleStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO);
    multisample.rasterizationSamples = samples;
    auto depthState = vkStruct<VkPipelineDepthStencilStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO);
    depthState.depthTestEnable = room;
    depthState.depthWriteEnable = room;
    depthState.depthCompareOp = VK_COMPARE_OP_LESS_OR_EQUAL;
    VkPipelineColorBlendAttachmentState blend{};
    blend.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                           VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    if (!room) {
        blend.blendEnable = VK_TRUE;
        blend.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
        blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        blend.colorBlendOp = VK_BLEND_OP_ADD;
        blend.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
        blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
        blend.alphaBlendOp = VK_BLEND_OP_ADD;
    }
    auto blendState = vkStruct<VkPipelineColorBlendStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO);
    blendState.attachmentCount = 1;
    blendState.pAttachments = &blend;
    const VkDynamicState dynamics[]{VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
    auto dynamic = vkStruct<VkPipelineDynamicStateCreateInfo>(
        VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO);
    dynamic.dynamicStateCount = 2;
    dynamic.pDynamicStates = dynamics;
    auto info =
        vkStruct<VkGraphicsPipelineCreateInfo>(VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO);
    info.stageCount = 2;
    info.pStages = stages;
    info.pVertexInputState = &vertexInput;
    info.pInputAssemblyState = &assembly;
    info.pViewportState = &viewport;
    info.pRasterizationState = &raster;
    info.pMultisampleState = &multisample;
    info.pDepthStencilState = &depthState;
    info.pColorBlendState = &blendState;
    info.pDynamicState = &dynamic;
    info.layout = layout;
    info.renderPass = renderPass;
    info.subpass = 0;
    VkPipeline out = VK_NULL_HANDLE;
    const auto result = vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &info, nullptr, &out);
    for (auto module : modules)
        vkDestroyShaderModule(device, module, nullptr);
    vk(result, "vkCreateGraphicsPipelines");
    return out;
}

void Gpu::createWorld(const WorldImages &images, Msaa msaa, const RoomMesh &mesh) {
    destroyWorld();
    world = images;
    worldMsaa = msaa;
    if (msaa == Msaa::RenderToSingle4 && !renderToSingleEnabled)
        throw std::runtime_error("4ms needs VK_EXT_multisampled_render_to_single_sampled");
    const bool fdm = !world.density.empty() &&
                     std::none_of(world.density.begin(), world.density.end(),
                                  [](VkImage image) { return image == VK_NULL_HANDLE; }) &&
                     deviceCaps.fragmentDensityMap;
    // [VK-FDMO]: offsets need the OFFSET create bit on every attachment of the pass, including
    // the ones the app creates ([GD-RDV] L2323-2325 sets it on every attachment image).
    VkImageCreateFlags flags = 0;
    if (fdm && world.offsetFlag && offsetFeatureEnabled)
        flags |= VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM;
    if (fdm && world.subsampled)
        flags |= VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT;
    if (msaa == Msaa::RenderToSingle4)
        flags |= VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT;
    const auto samples = msaa == Msaa::Single ? VK_SAMPLE_COUNT_1_BIT : VK_SAMPLE_COUNT_4_BIT;
    const auto attachmentSamples =
        msaa == Msaa::Resolve4 ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT;
    if (samples == VK_SAMPLE_COUNT_4_BIT && (!(deviceCaps.colorSamples & VK_SAMPLE_COUNT_4_BIT) ||
                                             !(deviceCaps.depthSamples & VK_SAMPLE_COUNT_4_BIT)))
        throw std::runtime_error("4x MSAA framebuffers are not supported");
    const auto depthAspect = deviceCaps.depthFormat == VK_FORMAT_D24_UNORM_S8_UINT
                                 ? VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT
                                 : VK_IMAGE_ASPECT_DEPTH_BIT;
    if (msaa == Msaa::Resolve4)
        msaaColor =
            attachment(world.format, VK_SAMPLE_COUNT_4_BIT, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT,
                       flags, VK_IMAGE_ASPECT_COLOR_BIT);
    depth = attachment(deviceCaps.depthFormat, attachmentSamples,
                       VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, flags, depthAspect);

    // Attachments: [MSAA colour], depth, swapchain colour (the resolve target with MSAA), [FDM].
    std::vector<VkAttachmentDescription2> descriptions;
    auto describe = [&](VkFormat format, VkSampleCountFlagBits count, VkAttachmentLoadOp load,
                        VkAttachmentStoreOp store, VkImageLayout initial, VkImageLayout final) {
        auto d = vkStruct<VkAttachmentDescription2>(VK_STRUCTURE_TYPE_ATTACHMENT_DESCRIPTION_2);
        d.format = format;
        d.samples = count;
        d.loadOp = load;
        d.storeOp = store;
        d.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
        d.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
        d.initialLayout = initial;
        d.finalLayout = final;
        descriptions.push_back(d);
        return static_cast<uint32_t>(descriptions.size() - 1);
    };
    constexpr auto colorLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    constexpr auto depthLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    uint32_t colorIndex = 0, depthIndex = 0, swapchainIndex = 0,
             densityIndex = VK_ATTACHMENT_UNUSED;
    // [XR-VK2] "Swapchain Image Layout": after xrWaitSwapchainImage the image is compatible with
    // COLOR_ATTACHMENT_OPTIMAL and must be released in it ([HXR] uses it as initial and final).
    if (msaa == Msaa::Resolve4) {
        colorIndex =
            describe(world.format, VK_SAMPLE_COUNT_4_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR,
                     VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, colorLayout);
        depthIndex =
            describe(deviceCaps.depthFormat, VK_SAMPLE_COUNT_4_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR,
                     VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, depthLayout);
        swapchainIndex =
            describe(world.format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_DONT_CARE,
                     VK_ATTACHMENT_STORE_OP_STORE, colorLayout, colorLayout);
    } else {
        swapchainIndex = colorIndex =
            describe(world.format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR,
                     VK_ATTACHMENT_STORE_OP_STORE, colorLayout, colorLayout);
        depthIndex =
            describe(deviceCaps.depthFormat, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR,
                     VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, depthLayout);
    }
    // [VK-FDM]: the density map attachment is FRAGMENT_DENSITY_MAP_OPTIMAL_EXT (or GENERAL),
    // loaded or don't-care, never stored; [GD-RD] uses LOAD / DONT_CARE with that layout.
    if (fdm)
        densityIndex = describe(VK_FORMAT_R8G8_UNORM, VK_SAMPLE_COUNT_1_BIT,
                                VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_DONT_CARE,
                                VK_IMAGE_LAYOUT_FRAGMENT_DENSITY_MAP_OPTIMAL_EXT,
                                VK_IMAGE_LAYOUT_FRAGMENT_DENSITY_MAP_OPTIMAL_EXT);
    attachmentCount = static_cast<uint32_t>(descriptions.size());

    VkAttachmentReference2 colorRef{VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2, nullptr, colorIndex,
                                    colorLayout, VK_IMAGE_ASPECT_COLOR_BIT};
    VkAttachmentReference2 resolveRef{VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2, nullptr,
                                      swapchainIndex, colorLayout, VK_IMAGE_ASPECT_COLOR_BIT};
    VkAttachmentReference2 depthRef{VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2, nullptr, depthIndex,
                                    depthLayout, 0};
    auto renderToSingle = vkStruct<VkMultisampledRenderToSingleSampledInfoEXT>(
        VK_STRUCTURE_TYPE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_INFO_EXT);
    renderToSingle.multisampledRenderToSingleSampledEnable = VK_TRUE;
    renderToSingle.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT;
    auto subpass = vkStruct<VkSubpassDescription2>(VK_STRUCTURE_TYPE_SUBPASS_DESCRIPTION_2);
    subpass.pNext = msaa == Msaa::RenderToSingle4 ? &renderToSingle : nullptr;
    subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    // [GD-RDV] render_pass_create: viewMask (1 << views) - 1 for multiview.
    subpass.viewMask = 0b11;
    subpass.colorAttachmentCount = 1;
    subpass.pColorAttachments = &colorRef;
    subpass.pResolveAttachments = msaa == Msaa::Resolve4 ? &resolveRef : nullptr;
    subpass.pDepthStencilAttachment = &depthRef;
    // Order this frame's attachment writes after earlier frames' (the transient images are shared
    // by every frame in flight).
    auto dependency = vkStruct<VkSubpassDependency2>(VK_STRUCTURE_TYPE_SUBPASS_DEPENDENCY_2);
    dependency.srcSubpass = VK_SUBPASS_EXTERNAL;
    dependency.dstSubpass = 0;
    dependency.srcStageMask =
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
    dependency.dstStageMask =
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT;
    dependency.srcAccessMask =
        VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    dependency.dstAccessMask =
        VK_ACCESS_COLOR_ATTACHMENT_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT |
        VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_READ_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    const uint32_t correlation = 0b11;
    auto densityInfo = vkStruct<VkRenderPassFragmentDensityMapCreateInfoEXT>(
        VK_STRUCTURE_TYPE_RENDER_PASS_FRAGMENT_DENSITY_MAP_CREATE_INFO_EXT);
    densityInfo.fragmentDensityMapAttachment = {densityIndex,
                                                VK_IMAGE_LAYOUT_FRAGMENT_DENSITY_MAP_OPTIMAL_EXT};
    auto passInfo = vkStruct<VkRenderPassCreateInfo2>(VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO_2);
    // [GD-RDV] L5582-5592: VkRenderPassFragmentDensityMapCreateInfoEXT on the create info.
    passInfo.pNext = fdm ? &densityInfo : nullptr;
    passInfo.attachmentCount = attachmentCount;
    passInfo.pAttachments = descriptions.data();
    passInfo.subpassCount = 1;
    passInfo.pSubpasses = &subpass;
    passInfo.dependencyCount = 1;
    passInfo.pDependencies = &dependency;
    passInfo.correlatedViewMaskCount = 1;
    passInfo.pCorrelatedViewMasks = &correlation;
    vk(createRenderPass2(device, &passInfo, nullptr, &renderPass), "vkCreateRenderPass2");

    for (VkImage image : world.color)
        colorViews.push_back(arrayView(image, world.format, VK_IMAGE_ASPECT_COLOR_BIT));
    if (fdm)
        // [GD-VKX] L427-438: the runtime's density image viewed as R8G8_UNORM, array of 2.
        for (VkImage image : world.density)
            densityViews.push_back(
                arrayView(image, VK_FORMAT_R8G8_UNORM, VK_IMAGE_ASPECT_COLOR_BIT));
    densityReady.assign(world.color.size(), false);
    for (size_t i = 0; i < world.color.size(); ++i) {
        std::vector<VkImageView> views;
        if (msaa == Msaa::Resolve4)
            views = {msaaColor.view, depth.view, colorViews[i]};
        else
            views = {colorViews[i], depth.view};
        if (fdm)
            views.push_back(densityViews[i]);
        auto info = vkStruct<VkFramebufferCreateInfo>(VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO);
        info.renderPass = renderPass;
        info.attachmentCount = static_cast<uint32_t>(views.size());
        info.pAttachments = views.data();
        info.width = world.width;
        info.height = world.height;
        info.layers = 1; // multiview render passes use one framebuffer layer ([GD-RDV] L4241)
        VkFramebuffer framebuffer = VK_NULL_HANDLE;
        vk(vkCreateFramebuffer(device, &info, nullptr, &framebuffer), "vkCreateFramebuffer");
        framebuffers.push_back(framebuffer);
    }

    VkDescriptorSetLayoutBinding uniformBinding{
        0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1,
        VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
    auto setInfo = vkStruct<VkDescriptorSetLayoutCreateInfo>(
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO);
    setInfo.bindingCount = 1;
    setInfo.pBindings = &uniformBinding;
    vk(vkCreateDescriptorSetLayout(device, &setInfo, nullptr, &setLayout),
       "vkCreateDescriptorSetLayout");
    auto layoutInfo =
        vkStruct<VkPipelineLayoutCreateInfo>(VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO);
    layoutInfo.setLayoutCount = 1;
    layoutInfo.pSetLayouts = &setLayout;
    vk(vkCreatePipelineLayout(device, &layoutInfo, nullptr, &layout), "vkCreatePipelineLayout");
    roomPipeline = pipeline(roomVert, sizeof(roomVert), roomFrag, sizeof(roomFrag), true, samples);
    overlayPipeline = pipeline(overlayVert, sizeof(overlayVert), overlayFrag, sizeof(overlayFrag),
                               false, samples);

    VkPhysicalDeviceProperties properties{};
    vkGetPhysicalDeviceProperties(physical, &properties);
    const VkDeviceSize alignment =
        std::max<VkDeviceSize>(properties.limits.minUniformBufferOffsetAlignment, 16);
    uniformStride = (sizeof(FrameUniforms) + alignment - 1) / alignment * alignment;
    uniforms = hostBuffer(uniformStride * Slots, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT);
    vertices =
        hostBuffer(mesh.vertices.size() * sizeof(RoomVertex), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT);
    memcpy(vertices.mapped, mesh.vertices.data(), mesh.vertices.size() * sizeof(RoomVertex));
    indices = hostBuffer(mesh.indices.size() * sizeof(uint16_t), VK_BUFFER_USAGE_INDEX_BUFFER_BIT);
    memcpy(indices.mapped, mesh.indices.data(), mesh.indices.size() * sizeof(uint16_t));
    indexCount = static_cast<uint32_t>(mesh.indices.size());

    VkDescriptorPoolSize poolSize{VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, Slots};
    auto poolInfo =
        vkStruct<VkDescriptorPoolCreateInfo>(VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO);
    poolInfo.maxSets = Slots;
    poolInfo.poolSizeCount = 1;
    poolInfo.pPoolSizes = &poolSize;
    vk(vkCreateDescriptorPool(device, &poolInfo, nullptr, &descriptorPool),
       "vkCreateDescriptorPool");
    std::array<VkDescriptorSetLayout, Slots> setLayouts;
    setLayouts.fill(setLayout);
    auto allocate =
        vkStruct<VkDescriptorSetAllocateInfo>(VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO);
    allocate.descriptorPool = descriptorPool;
    allocate.descriptorSetCount = Slots;
    allocate.pSetLayouts = setLayouts.data();
    vk(vkAllocateDescriptorSets(device, &allocate, sets.data()), "vkAllocateDescriptorSets");
    for (uint32_t slot = 0; slot < Slots; ++slot) {
        VkDescriptorBufferInfo bufferInfo{uniforms.buffer, uniformStride * slot,
                                          sizeof(FrameUniforms)};
        auto write = vkStruct<VkWriteDescriptorSet>(VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET);
        write.dstSet = sets[slot];
        write.descriptorCount = 1;
        write.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
        write.pBufferInfo = &bufferInfo;
        vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
    }

    auto poolCreate = vkStruct<VkCommandPoolCreateInfo>(VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO);
    poolCreate.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    poolCreate.queueFamilyIndex = deviceCaps.queueFamily;
    vk(vkCreateCommandPool(device, &poolCreate, nullptr, &commandPool), "vkCreateCommandPool");
    auto commandInfo =
        vkStruct<VkCommandBufferAllocateInfo>(VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO);
    commandInfo.commandPool = commandPool;
    commandInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    commandInfo.commandBufferCount = Slots;
    vk(vkAllocateCommandBuffers(device, &commandInfo, commands.data()), "vkAllocateCommandBuffers");
    for (uint32_t slot = 0; slot < Slots; ++slot) {
        auto fenceInfo = vkStruct<VkFenceCreateInfo>(VK_STRUCTURE_TYPE_FENCE_CREATE_INFO);
        fenceInfo.flags = VK_FENCE_CREATE_SIGNALED_BIT;
        vk(vkCreateFence(device, &fenceInfo, nullptr, &fences[slot]), "vkCreateFence");
        if (deviceCaps.timestampValidBits) {
            auto queryInfo =
                vkStruct<VkQueryPoolCreateInfo>(VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO);
            queryInfo.queryType = VK_QUERY_TYPE_TIMESTAMP;
            queryInfo.queryCount = 2;
            vk(vkCreateQueryPool(device, &queryInfo, nullptr, &queries[slot]), "vkCreateQueryPool");
        }
        queryPending[slot] = false;
    }
    LOG("VK_WORLD size=%ux%u format=%d msaa=%s fdm=%d density=%ux%u offsetFlag=%d subsampled=%d "
        "attachments=%u images=%zu",
        world.width, world.height, world.format, name(msaa), fdm, world.densityWidth,
        world.densityHeight, (flags & VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM) != 0,
        world.subsampled, attachmentCount, world.color.size());
}

void Gpu::render(uint32_t index, const RecordInput &input) {
    if (index >= framebuffers.size())
        throw std::runtime_error("World image index out of range");
    const uint32_t slot = static_cast<uint32_t>(frame % Slots);
    vk(vkWaitForFences(device, 1, &fences[slot], VK_TRUE, UINT64_MAX), "vkWaitForFences");
    if (queryPending[slot]) {
        uint64_t stamps[2]{};
        if (vkGetQueryPoolResults(device, queries[slot], 0, 2, sizeof(stamps), stamps,
                                  sizeof(uint64_t), VK_QUERY_RESULT_64_BIT) == VK_SUCCESS) {
            const uint64_t mask = deviceCaps.timestampValidBits >= 64
                                      ? ~0ull
                                      : (1ull << deviceCaps.timestampValidBits) - 1;
            lastGpuMs = static_cast<double>((stamps[1] - stamps[0]) & mask) *
                        deviceCaps.timestampPeriod / 1e6;
        }
        queryPending[slot] = false;
    }
    vk(vkResetFences(device, 1, &fences[slot]), "vkResetFences");
    memcpy(static_cast<char *>(uniforms.mapped) + uniformStride * slot, &input.uniforms,
           sizeof(FrameUniforms));

    VkCommandBuffer cmd = commands[slot];
    vk(vkResetCommandBuffer(cmd, 0), "vkResetCommandBuffer");
    auto begin = vkStruct<VkCommandBufferBeginInfo>(VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO);
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vk(vkBeginCommandBuffer(cmd, &begin), "vkBeginCommandBuffer");
    // Outside the render pass: a multiview pass would write one timestamp per view.
    if (queries[slot]) {
        vkCmdResetQueryPool(cmd, queries[slot], 0, 2);
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, queries[slot], 0);
    }
    if (!densityViews.empty() && !densityReady[index]) {
        // UNDOCUMENTED for this runtime (vulkan-port.md 4.3): one transition of each imported
        // density image to FRAGMENT_DENSITY_MAP_OPTIMAL_EXT before its first use, as Godot's render
        // graph does for an imported texture (rendering_device_graph.cpp L160, L215).
        auto barrier = vkStruct<VkImageMemoryBarrier>(VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER);
        barrier.srcAccessMask = 0;
        barrier.dstAccessMask = VK_ACCESS_FRAGMENT_DENSITY_MAP_READ_BIT_EXT;
        barrier.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        barrier.newLayout = VK_IMAGE_LAYOUT_FRAGMENT_DENSITY_MAP_OPTIMAL_EXT;
        barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = world.density[index];
        barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 2};
        vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
                             VK_PIPELINE_STAGE_FRAGMENT_DENSITY_PROCESS_BIT_EXT, 0, 0, nullptr, 0,
                             nullptr, 1, &barrier);
        densityReady[index] = true;
    }
    // Attachment 0 is the cleared colour target and 1 the depth in every layout createWorld
    // builds; the resolve and density attachments ignore their entries.
    std::array<VkClearValue, 4> clears{};
    for (auto &clear : clears)
        clear.color = {{0.02f, 0.02f, 0.03f, 1}};
    clears[1].depthStencil = {1, 0};
    auto pass = vkStruct<VkRenderPassBeginInfo>(VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO);
    pass.renderPass = renderPass;
    pass.framebuffer = framebuffers[index];
    // The whole image: Godot drops the runtime density map for sub-rectangles
    // (openxr_api.cpp L2913-2928).
    pass.renderArea = {{0, 0}, {world.width, world.height}};
    pass.clearValueCount = attachmentCount;
    pass.pClearValues = clears.data();
    // The density map is read by the host here unless its view is dynamic or deferred
    // ([VK-FDM]); the caller has already run xrUpdateSwapchainFB for this frame.
    vkCmdBeginRenderPass(cmd, &pass, VK_SUBPASS_CONTENTS_INLINE);
    // Negative height (core since Vulkan 1.1): NDC +y is image row 0, the top of an OpenXR
    // Vulkan image ([XR-VK2] "top-left corner ... coordinate origin"), with GL matrices.
    const VkViewport viewport{0,
                              static_cast<float>(world.height),
                              static_cast<float>(world.width),
                              -static_cast<float>(world.height),
                              0,
                              1};
    const VkRect2D scissor{{0, 0}, {world.width, world.height}};
    vkCmdSetViewport(cmd, 0, 1, &viewport);
    vkCmdSetScissor(cmd, 0, 1, &scissor);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[slot], 0,
                            nullptr);
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, roomPipeline);
    const VkDeviceSize zero = 0;
    vkCmdBindVertexBuffers(cmd, 0, 1, &vertices.buffer, &zero);
    vkCmdBindIndexBuffer(cmd, indices.buffer, 0, VK_INDEX_TYPE_UINT16);
    vkCmdDrawIndexed(cmd, indexCount, 1, 0, 0, 0);
    if (input.overlay) {
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, overlayPipeline);
        vkCmdDraw(cmd, 3, 1, 0, 0);
    }
    if (input.applyOffsets && !densityViews.empty()) {
        // [GD-RDV] L5655-5680: per-layer offsets at the end of the pass. With multiview the count
        // equals the density map view's layer count, 2 ([VK-FDMO]).
        const VkOffset2D offsets[2]{{input.offsets[0].x, input.offsets[0].y},
                                    {input.offsets[1].x, input.offsets[1].y}};
        auto offsetInfo = vkStruct<VkSubpassFragmentDensityMapOffsetEndInfoQCOM>(
            VK_STRUCTURE_TYPE_SUBPASS_FRAGMENT_DENSITY_MAP_OFFSET_END_INFO_QCOM);
        offsetInfo.fragmentDensityOffsetCount = 2;
        offsetInfo.pFragmentDensityOffsets = offsets;
        auto end = vkStruct<VkSubpassEndInfo>(VK_STRUCTURE_TYPE_SUBPASS_END_INFO);
        end.pNext = &offsetInfo;
        endRenderPass2(cmd, &end);
    } else
        vkCmdEndRenderPass(cmd);
    if (queries[slot])
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, queries[slot], 1);
    vk(vkEndCommandBuffer(cmd), "vkEndCommandBuffer");
    auto submit = vkStruct<VkSubmitInfo>(VK_STRUCTURE_TYPE_SUBMIT_INFO);
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &cmd;
    // [XR-VK2] "Concurrency": this thread also makes every xrBeginFrame, xrEndFrame and
    // acquire/release call, so the shared queue is externally synchronized.
    vk(vkQueueSubmit(queue, 1, &submit, fences[slot]), "vkQueueSubmit");
    queryPending[slot] = queries[slot] != VK_NULL_HANDLE;
    ++frame;
}

void Gpu::waitIdle() {
    if (device)
        vkDeviceWaitIdle(device);
}

void Gpu::destroyWorld() {
    if (!device)
        return;
    vkDeviceWaitIdle(device);
    for (auto &fence : fences)
        if (fence) {
            vkDestroyFence(device, fence, nullptr);
            fence = VK_NULL_HANDLE;
        }
    for (auto &pool : queries)
        if (pool) {
            vkDestroyQueryPool(device, pool, nullptr);
            pool = VK_NULL_HANDLE;
        }
    if (commandPool)
        vkDestroyCommandPool(device, commandPool, nullptr);
    commandPool = VK_NULL_HANDLE;
    commands = {};
    if (roomPipeline)
        vkDestroyPipeline(device, roomPipeline, nullptr);
    if (overlayPipeline)
        vkDestroyPipeline(device, overlayPipeline, nullptr);
    roomPipeline = overlayPipeline = VK_NULL_HANDLE;
    if (layout)
        vkDestroyPipelineLayout(device, layout, nullptr);
    layout = VK_NULL_HANDLE;
    if (descriptorPool)
        vkDestroyDescriptorPool(device, descriptorPool, nullptr);
    descriptorPool = VK_NULL_HANDLE;
    sets = {};
    if (setLayout)
        vkDestroyDescriptorSetLayout(device, setLayout, nullptr);
    setLayout = VK_NULL_HANDLE;
    destroy(uniforms);
    destroy(vertices);
    destroy(indices);
    for (auto framebuffer : framebuffers)
        vkDestroyFramebuffer(device, framebuffer, nullptr);
    framebuffers.clear();
    // The swapchain and density images belong to the runtime; only the views are ours
    // ([HXR] "we don't own color/depthImage").
    for (auto view : colorViews)
        vkDestroyImageView(device, view, nullptr);
    for (auto view : densityViews)
        vkDestroyImageView(device, view, nullptr);
    colorViews.clear();
    densityViews.clear();
    densityReady.clear();
    destroy(msaaColor);
    destroy(depth);
    if (renderPass)
        vkDestroyRenderPass(device, renderPass, nullptr);
    renderPass = VK_NULL_HANDLE;
    frame = 0;
}

void Gpu::destroyDevice() {
    destroyWorld();
    if (device)
        vkDestroyDevice(device, nullptr);
    device = VK_NULL_HANDLE;
    if (instance)
        vkDestroyInstance(instance, nullptr);
    instance = VK_NULL_HANDLE;
}

} // namespace office::spike
