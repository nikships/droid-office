// Renders a recorded packet stream with the real VkSceneRenderer on a host Vulkan device (Mesa
// lavapipe in CI), the way world_vk.cpp does on the headset: one multiview pass (view mask 0b11)
// into a 2-layer R8G8B8A8_SRGB image, optionally with 4x MSAA resolved in the subpass, several
// frames in flight, a negative-height viewport. Writes both layers as PPMs (top row first, like
// the GLES render's) for the parity check against the GLES render of the same fixture and eyes,
// and fails on a validation layer message, a rejected packet, a failed pipeline or an incomplete
// load.
//   vk-render <packets.json> <out-dir> [--size px] [--seconds s] [--samples 1|4] [--name prefix]
//             [--look ex,ey,ez,tx,ty,tz]
#include "vk_scene_renderer.h"

#include <vulkan/vulkan.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace office;
using json = nlohmann::json;

namespace {

void vk(VkResult result, const char *what) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(what) + ": VkResult " + std::to_string(result));
}

template <class T> T vkStruct(VkStructureType type) {
    T value{};
    value.sType = type;
    return value;
}

struct Mat {
    float m[16];
};

// The GLES render's eyes (render.cpp perspective and viewFromWorld), so both see the same view.
Mat perspective(float fovDeg, float aspect, float n, float f) {
    float t = 1.0f / std::tan(fovDeg * 3.14159265f / 360.0f);
    Mat r{};
    r.m[0] = t / aspect;
    r.m[5] = t;
    r.m[10] = -(f + n) / (f - n);
    r.m[11] = -1;
    r.m[14] = -2 * f * n / (f - n);
    return r;
}

Mat viewFromWorld(const std::vector<float> &a, float eyeOffsetX) {
    float t[3] = {a[9] + a[0] * eyeOffsetX, a[10] + a[1] * eyeOffsetX, a[11] + a[2] * eyeOffsetX};
    Mat v{};
    for (int r = 0; r < 3; r++) {
        v.m[0 * 4 + r] = a[r * 3 + 0];
        v.m[1 * 4 + r] = a[r * 3 + 1];
        v.m[2 * 4 + r] = a[r * 3 + 2];
    }
    for (int r = 0; r < 3; r++)
        v.m[12 + r] = -(a[r * 3 + 0] * t[0] + a[r * 3 + 1] * t[1] + a[r * 3 + 2] * t[2]);
    v.m[15] = 1;
    return v;
}

std::vector<float> lookCamera(const float *eye, const float *target) {
    float z[3] = {eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]};
    float n = std::sqrt(z[0] * z[0] + z[1] * z[1] + z[2] * z[2]);
    for (float &c : z)
        c /= n;
    float x[3] = {z[2], 0, -z[0]}; // up (0,1,0) x z
    n = std::sqrt(x[0] * x[0] + x[2] * x[2]);
    for (float &c : x)
        c /= n;
    float y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
    return {x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2], eye[0], eye[1], eye[2]};
}

bool writePpm(const std::string &path, const uint8_t *rgba, int w, int h) {
    FILE *f = std::fopen(path.c_str(), "wb");
    if (!f)
        return false;
    std::fprintf(f, "P6\n%d %d\n255\n", w, h);
    // Row 0 of a Vulkan image is its top (research/vulkan-port.md 4.3).
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
            std::fwrite(&rgba[size_t(y * w + x) * 4], 1, 3, f);
    std::fclose(f);
    return true;
}

int validationMessages = 0;

VKAPI_ATTR VkBool32 VKAPI_CALL onMessage(VkDebugUtilsMessageSeverityFlagBitsEXT severity,
                                         VkDebugUtilsMessageTypeFlagsEXT,
                                         const VkDebugUtilsMessengerCallbackDataEXT *data, void *) {
    if (severity >= VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT) {
        if (validationMessages++ < 20)
            std::printf("VALIDATION: %s\n", data->pMessage);
    }
    return VK_FALSE;
}

uint32_t memoryType(VkPhysicalDevice physical, uint32_t allowed, VkMemoryPropertyFlags want) {
    VkPhysicalDeviceMemoryProperties memory{};
    vkGetPhysicalDeviceMemoryProperties(physical, &memory);
    for (uint32_t i = 0; i < memory.memoryTypeCount; ++i)
        if ((allowed & (1u << i)) && (memory.memoryTypes[i].propertyFlags & want) == want)
            return i;
    throw std::runtime_error("no memory type");
}

struct Image {
    VkImage image = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    VkImageView view = VK_NULL_HANDLE;
};

Image makeImage(VkDevice device, VkPhysicalDevice physical, VkFormat format, uint32_t size,
                VkSampleCountFlagBits samples, VkImageUsageFlags usage, VkImageAspectFlags aspect) {
    Image out;
    auto info = vkStruct<VkImageCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO);
    info.imageType = VK_IMAGE_TYPE_2D;
    info.format = format;
    info.extent = {size, size, 1};
    info.mipLevels = 1;
    info.arrayLayers = 2;
    info.samples = samples;
    info.tiling = VK_IMAGE_TILING_OPTIMAL;
    info.usage = usage;
    vk(vkCreateImage(device, &info, nullptr, &out.image), "vkCreateImage");
    VkMemoryRequirements req{};
    vkGetImageMemoryRequirements(device, out.image, &req);
    auto alloc = vkStruct<VkMemoryAllocateInfo>(VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO);
    alloc.allocationSize = req.size;
    alloc.memoryTypeIndex =
        memoryType(physical, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    vk(vkAllocateMemory(device, &alloc, nullptr, &out.memory), "vkAllocateMemory");
    vk(vkBindImageMemory(device, out.image, out.memory, 0), "vkBindImageMemory");
    auto view = vkStruct<VkImageViewCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO);
    view.image = out.image;
    view.viewType = VK_IMAGE_VIEW_TYPE_2D_ARRAY;
    view.format = format;
    view.subresourceRange = {aspect, 0, 1, 0, 2};
    vk(vkCreateImageView(device, &view, nullptr, &out.view), "vkCreateImageView");
    return out;
}

} // namespace

int main(int argc, char **argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: vk-render <packets.json> <out-dir> [--size px] [--seconds s] "
                             "[--samples 1|4] [--name prefix] [--look ...]\n");
        return 2;
    }
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    const std::string out = argv[2];
    uint32_t size = 640;
    double settle = 4.0;
    int samplesArg = 1;
    std::string name = "vk";
    std::vector<float> lookAt;
    for (int i = 3; i + 1 < argc; i += 2) {
        const std::string a = argv[i];
        if (a == "--size")
            size = uint32_t(std::atoi(argv[i + 1]));
        else if (a == "--seconds")
            settle = std::atof(argv[i + 1]);
        else if (a == "--samples")
            samplesArg = std::atoi(argv[i + 1]);
        else if (a == "--name")
            name = argv[i + 1];
        else if (a == "--look") {
            std::stringstream ss(argv[i + 1]);
            for (std::string part; std::getline(ss, part, ',');)
                lookAt.push_back(std::stof(part));
        }
    }
    const VkSampleCountFlagBits samples =
        samplesArg == 4 ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT;
    std::vector<std::string> failed;
    auto check = [&](bool ok, const std::string &what) {
        if (ok)
            return;
        std::printf("FAIL: %s\n", what.c_str());
        failed.push_back(what);
    };
    try {
        // ---- Instance with the Khronos validation layer and a messenger that counts messages.
        uint32_t layerCount = 0;
        vkEnumerateInstanceLayerProperties(&layerCount, nullptr);
        std::vector<VkLayerProperties> layers(layerCount);
        vkEnumerateInstanceLayerProperties(&layerCount, layers.data());
        const bool validation = std::any_of(layers.begin(), layers.end(), [](const auto &l) {
            return std::strcmp(l.layerName, "VK_LAYER_KHRONOS_validation") == 0;
        });
        check(validation, "VK_LAYER_KHRONOS_validation is not installed (vulkan-validationlayers)");
        const char *layerName = "VK_LAYER_KHRONOS_validation";
        const char *debugUtils = VK_EXT_DEBUG_UTILS_EXTENSION_NAME;
        auto messenger = vkStruct<VkDebugUtilsMessengerCreateInfoEXT>(
            VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT);
        messenger.messageSeverity = VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
                                    VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
        messenger.messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT |
                                VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
                                VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
        messenger.pfnUserCallback = onMessage;
        auto app = vkStruct<VkApplicationInfo>(VK_STRUCTURE_TYPE_APPLICATION_INFO);
        app.pApplicationName = "office vk-render";
        app.apiVersion = VK_API_VERSION_1_1;
        auto instanceInfo = vkStruct<VkInstanceCreateInfo>(VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO);
        instanceInfo.pApplicationInfo = &app;
        if (validation) {
            instanceInfo.pNext = &messenger;
            instanceInfo.enabledLayerCount = 1;
            instanceInfo.ppEnabledLayerNames = &layerName;
            instanceInfo.enabledExtensionCount = 1;
            instanceInfo.ppEnabledExtensionNames = &debugUtils;
        }
        VkInstance instance = VK_NULL_HANDLE;
        vk(vkCreateInstance(&instanceInfo, nullptr, &instance), "vkCreateInstance");
        VkDebugUtilsMessengerEXT debug = VK_NULL_HANDLE;
        if (validation) {
            auto create = reinterpret_cast<PFN_vkCreateDebugUtilsMessengerEXT>(
                vkGetInstanceProcAddr(instance, "vkCreateDebugUtilsMessengerEXT"));
            vk(create(instance, &messenger, nullptr, &debug), "vkCreateDebugUtilsMessengerEXT");
        }

        // ---- The first device with a graphics queue and multiview.
        uint32_t deviceCount = 0;
        vkEnumeratePhysicalDevices(instance, &deviceCount, nullptr);
        std::vector<VkPhysicalDevice> devices(deviceCount);
        vkEnumeratePhysicalDevices(instance, &deviceCount, devices.data());
        if (devices.empty())
            throw std::runtime_error("no Vulkan device (install mesa-vulkan-drivers for lavapipe)");
        VkPhysicalDevice physical = devices[0];
        VkPhysicalDeviceProperties properties{};
        vkGetPhysicalDeviceProperties(physical, &properties);
        std::printf("Vulkan: %s, API %u.%u.%u\n", properties.deviceName,
                    VK_API_VERSION_MAJOR(properties.apiVersion),
                    VK_API_VERSION_MINOR(properties.apiVersion),
                    VK_API_VERSION_PATCH(properties.apiVersion));
        uint32_t familyCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(physical, &familyCount, nullptr);
        std::vector<VkQueueFamilyProperties> families(familyCount);
        vkGetPhysicalDeviceQueueFamilyProperties(physical, &familyCount, families.data());
        uint32_t family = UINT32_MAX;
        for (uint32_t i = 0; i < familyCount && family == UINT32_MAX; i++)
            if (families[i].queueFlags & VK_QUEUE_GRAPHICS_BIT)
                family = i;
        if (family == UINT32_MAX)
            throw std::runtime_error("no graphics queue family");
        auto multiview = vkStruct<VkPhysicalDeviceMultiviewFeatures>(
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_FEATURES);
        auto features =
            vkStruct<VkPhysicalDeviceFeatures2>(VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2);
        features.pNext = &multiview;
        vkGetPhysicalDeviceFeatures2(physical, &features);
        if (!multiview.multiview)
            throw std::runtime_error("the device has no multiview");
        auto enableMultiview = vkStruct<VkPhysicalDeviceMultiviewFeatures>(
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_FEATURES);
        enableMultiview.multiview = VK_TRUE;
        auto enable =
            vkStruct<VkPhysicalDeviceFeatures2>(VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2);
        enable.pNext = &enableMultiview;
        enable.features.samplerAnisotropy = features.features.samplerAnisotropy;
        enable.features.largePoints = features.features.largePoints;
        const float priority = 1;
        auto queueInfo =
            vkStruct<VkDeviceQueueCreateInfo>(VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO);
        queueInfo.queueFamilyIndex = family;
        queueInfo.queueCount = 1;
        queueInfo.pQueuePriorities = &priority;
        auto deviceInfo = vkStruct<VkDeviceCreateInfo>(VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO);
        deviceInfo.pNext = &enable;
        deviceInfo.queueCreateInfoCount = 1;
        deviceInfo.pQueueCreateInfos = &queueInfo;
        VkDevice device = VK_NULL_HANDLE;
        vk(vkCreateDevice(physical, &deviceInfo, nullptr, &device), "vkCreateDevice");
        VkQueue queue = VK_NULL_HANDLE;
        vkGetDeviceQueue(device, family, 0, &queue);

        // ---- The world pass: multiview, colour (resolved from 4x MSAA in the subpass) + depth.
        const VkFormat color = VK_FORMAT_R8G8B8A8_SRGB, depthFormat = VK_FORMAT_D32_SFLOAT;
        std::vector<VkAttachmentDescription> attachments;
        auto describe = [&](VkFormat f, VkSampleCountFlagBits n, VkAttachmentLoadOp load,
                            VkAttachmentStoreOp store, VkImageLayout final) {
            VkAttachmentDescription d{};
            d.format = f;
            d.samples = n;
            d.loadOp = load;
            d.storeOp = store;
            d.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
            d.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
            d.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
            d.finalLayout = final;
            attachments.push_back(d);
            return uint32_t(attachments.size() - 1);
        };
        const bool msaa = samples != VK_SAMPLE_COUNT_1_BIT;
        uint32_t colorIndex, depthIndex, resolveIndex = VK_ATTACHMENT_UNUSED;
        if (msaa) {
            colorIndex = describe(color, samples, VK_ATTACHMENT_LOAD_OP_CLEAR,
                                  VK_ATTACHMENT_STORE_OP_DONT_CARE,
                                  VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
            depthIndex = describe(depthFormat, samples, VK_ATTACHMENT_LOAD_OP_CLEAR,
                                  VK_ATTACHMENT_STORE_OP_DONT_CARE,
                                  VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL);
            resolveIndex =
                describe(color, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_DONT_CARE,
                         VK_ATTACHMENT_STORE_OP_STORE, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
        } else {
            colorIndex =
                describe(color, samples, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
                         VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
            depthIndex = describe(depthFormat, samples, VK_ATTACHMENT_LOAD_OP_CLEAR,
                                  VK_ATTACHMENT_STORE_OP_DONT_CARE,
                                  VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL);
        }
        VkAttachmentReference colorRef{colorIndex, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
        VkAttachmentReference depthRef{depthIndex,
                                       VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
        VkAttachmentReference resolveRef{resolveIndex, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
        VkSubpassDescription subpass{};
        subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
        subpass.colorAttachmentCount = 1;
        subpass.pColorAttachments = &colorRef;
        subpass.pResolveAttachments = msaa ? &resolveRef : nullptr;
        subpass.pDepthStencilAttachment = &depthRef;
        VkSubpassDependency dependencies[2]{};
        // The attachments are shared by the frames in flight; the readback reads the last one.
        dependencies[0].srcSubpass = VK_SUBPASS_EXTERNAL;
        dependencies[0].dstSubpass = 0;
        dependencies[0].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT |
                                       VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT |
                                       VK_PIPELINE_STAGE_TRANSFER_BIT;
        dependencies[0].dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT |
                                       VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT;
        dependencies[0].srcAccessMask =
            VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[0].dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_READ_BIT |
                                        VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT |
                                        VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_READ_BIT |
                                        VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[1].srcSubpass = 0;
        dependencies[1].dstSubpass = VK_SUBPASS_EXTERNAL;
        dependencies[1].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        dependencies[1].dstStageMask = VK_PIPELINE_STAGE_TRANSFER_BIT;
        dependencies[1].srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
        dependencies[1].dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
        const uint32_t viewMask = 0b11, correlation = 0b11;
        auto multiviewPass = vkStruct<VkRenderPassMultiviewCreateInfo>(
            VK_STRUCTURE_TYPE_RENDER_PASS_MULTIVIEW_CREATE_INFO);
        multiviewPass.subpassCount = 1;
        multiviewPass.pViewMasks = &viewMask;
        multiviewPass.correlationMaskCount = 1;
        multiviewPass.pCorrelationMasks = &correlation;
        auto passInfo = vkStruct<VkRenderPassCreateInfo>(VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO);
        passInfo.pNext = &multiviewPass;
        passInfo.attachmentCount = uint32_t(attachments.size());
        passInfo.pAttachments = attachments.data();
        passInfo.subpassCount = 1;
        passInfo.pSubpasses = &subpass;
        passInfo.dependencyCount = 2;
        passInfo.pDependencies = dependencies;
        VkRenderPass renderPass = VK_NULL_HANDLE;
        vk(vkCreateRenderPass(device, &passInfo, nullptr, &renderPass), "vkCreateRenderPass");
        Image target =
            makeImage(device, physical, color, size, VK_SAMPLE_COUNT_1_BIT,
                      VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
                      VK_IMAGE_ASPECT_COLOR_BIT);
        Image depth =
            makeImage(device, physical, depthFormat, size, samples,
                      VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, VK_IMAGE_ASPECT_DEPTH_BIT);
        Image msaaColor;
        if (msaa)
            msaaColor = makeImage(device, physical, color, size, samples,
                                  VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, VK_IMAGE_ASPECT_COLOR_BIT);
        std::vector<VkImageView> views =
            msaa ? std::vector<VkImageView>{msaaColor.view, depth.view, target.view}
                 : std::vector<VkImageView>{target.view, depth.view};
        auto fbInfo = vkStruct<VkFramebufferCreateInfo>(VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO);
        fbInfo.renderPass = renderPass;
        fbInfo.attachmentCount = uint32_t(views.size());
        fbInfo.pAttachments = views.data();
        fbInfo.width = fbInfo.height = size;
        fbInfo.layers = 1; // multiview
        VkFramebuffer framebuffer = VK_NULL_HANDLE;
        vk(vkCreateFramebuffer(device, &fbInfo, nullptr, &framebuffer), "vkCreateFramebuffer");

        constexpr uint32_t kSlots = 3;
        auto poolInfo =
            vkStruct<VkCommandPoolCreateInfo>(VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO);
        poolInfo.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
        poolInfo.queueFamilyIndex = family;
        VkCommandPool pool = VK_NULL_HANDLE;
        vk(vkCreateCommandPool(device, &poolInfo, nullptr, &pool), "vkCreateCommandPool");
        VkCommandBuffer commands[kSlots + 1];
        auto cmdInfo =
            vkStruct<VkCommandBufferAllocateInfo>(VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO);
        cmdInfo.commandPool = pool;
        cmdInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cmdInfo.commandBufferCount = kSlots + 1;
        vk(vkAllocateCommandBuffers(device, &cmdInfo, commands), "vkAllocateCommandBuffers");
        VkFence fences[kSlots];
        for (VkFence &f : fences) {
            auto info = vkStruct<VkFenceCreateInfo>(VK_STRUCTURE_TYPE_FENCE_CREATE_INFO);
            info.flags = VK_FENCE_CREATE_SIGNALED_BIT;
            vk(vkCreateFence(device, &info, nullptr, &f), "vkCreateFence");
        }

        // ---- The scene, fed as the bridge would.
        std::ifstream in(argv[1], std::ios::binary);
        std::stringstream text;
        text << in.rdbuf();
        json packets = json::parse(text.str());
        if (!packets.is_array())
            throw std::runtime_error("not an array of packets");
        std::vector<float> camera = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.6f, 0};
        float fov = 55, nearZ = 0.1f, farZ = 320;
        for (const auto &p : packets)
            if (p.contains("camera")) {
                camera = p["camera"]["m"].get<std::vector<float>>();
                fov = p["camera"].value("fov", fov);
                nearZ = p["camera"].value("near", nearZ);
                farZ = p["camera"].value("far", farZ);
            }
        if (lookAt.size() == 6)
            camera = lookCamera(&lookAt[0], &lookAt[3]);
        SceneEye eyes[2];
        const Mat proj = perspective(fov, 1.0f, nearZ, farZ);
        for (int e = 0; e < 2; e++) {
            const Mat v = viewFromWorld(camera, e == 0 ? -0.032f : 0.032f);
            std::memcpy(eyes[e].view, v.m, sizeof v.m);
            std::memcpy(eyes[e].projection, proj.m, sizeof proj.m);
        }

        // Exercise the same default construction as world_vk.cpp, not fixture-only options.
        auto renderer = std::make_unique<VkSceneRenderer>();
        VkSceneDevice sceneDevice;
        sceneDevice.instance = instance;
        sceneDevice.physical = physical;
        sceneDevice.device = device;
        sceneDevice.samplerAnisotropy = enable.features.samplerAnisotropy;
        sceneDevice.largePoints = enable.features.largePoints;
        sceneDevice.timestampValidBits = families[family].timestampValidBits;
        if (!renderer->initialize(sceneDevice, kSlots, out + "/" + name + "-pipeline-cache.bin"))
            throw std::runtime_error("initialize: " + renderer->lastError());
        VkSceneTarget sceneTarget;
        sceneTarget.renderPass = renderPass;
        sceneTarget.samples = samples;
        sceneTarget.srgb = true;
        sceneTarget.compatibility = 1;
        renderer->setTarget(sceneTarget);

        uint64_t frame = 0;
        auto drawFrame = [&]() {
            const uint32_t s = uint32_t(frame % kSlots);
            vk(vkWaitForFences(device, 1, &fences[s], VK_TRUE, UINT64_MAX), "vkWaitForFences");
            vk(vkResetFences(device, 1, &fences[s]), "vkResetFences");
            // Waiting for this slot's fence completed every frame up to frame - kSlots.
            renderer->beginFrame(frame, frame >= kSlots ? frame - kSlots : 0);
            VkCommandBuffer cmd = commands[s];
            vk(vkResetCommandBuffer(cmd, 0), "vkResetCommandBuffer");
            auto begin =
                vkStruct<VkCommandBufferBeginInfo>(VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO);
            begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
            vk(vkBeginCommandBuffer(cmd, &begin), "vkBeginCommandBuffer");
            renderer->prepareFrame(cmd);
            VkClearValue clears[3]{};
            clears[colorIndex].color = renderer->clearColor();
            clears[depthIndex].depthStencil = {1, 0};
            auto pass = vkStruct<VkRenderPassBeginInfo>(VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO);
            pass.renderPass = renderPass;
            pass.framebuffer = framebuffer;
            pass.renderArea = {{0, 0}, {size, size}};
            pass.clearValueCount = uint32_t(attachments.size());
            pass.pClearValues = clears;
            vkCmdBeginRenderPass(cmd, &pass, VK_SUBPASS_CONTENTS_INLINE);
            renderer->render(cmd, eyes, size, size);
            vkCmdEndRenderPass(cmd);
            renderer->endFrame(cmd);
            vk(vkEndCommandBuffer(cmd), "vkEndCommandBuffer");
            auto submit = vkStruct<VkSubmitInfo>(VK_STRUCTURE_TYPE_SUBMIT_INFO);
            submit.commandBufferCount = 1;
            submit.pCommandBuffers = &cmd;
            vk(vkQueueSubmit(queue, 1, &submit, fences[s]), "vkQueueSubmit");
            frame++;
        };

        const auto t0 = std::chrono::steady_clock::now();
        size_t next = 0, rejected = 0;
        while (next < packets.size()) {
            for (int k = 0; k < 4 && next < packets.size(); k++, next++) {
                json copy = packets[next];
                if (!renderer->enqueue(std::move(copy)))
                    rejected++;
            }
            drawFrame();
        }
        std::printf("streamed %zu packets in %.2f s over %llu frames, rejected %zu\n",
                    packets.size(),
                    std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(),
                    (unsigned long long)frame, rejected);
        const auto s0 = std::chrono::steady_clock::now();
        while (std::chrono::duration<double>(std::chrono::steady_clock::now() - s0).count() <
               settle) {
            renderer->tick();
            drawFrame();
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        auto loaded = [](const SceneStats &s) {
            return s.stateSerial && !s.pendingUploads && !s.waitingState && !s.programsCompiling &&
                   !s.queuedTextureOps && !s.queuedBytes;
        };
        int loadFrames = 0;
        for (; loadFrames < 3000 && !loaded(renderer->stats()); loadFrames++) {
            renderer->tick();
            drawFrame();
            if (renderer->stats().programsCompiling)
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        // Two more frames so the drawn state has every pipeline the draws asked for.
        for (int i = 0; i < 2 * int(kSlots); i++)
            drawFrame();
        const SceneStats st = renderer->stats();
        std::printf("loaded after %d more frames: state %llu, pending uploads %u, compiling %u, "
                    "queued ops %u\n",
                    loadFrames, (unsigned long long)st.stateSerial, st.pendingUploads,
                    st.programsCompiling, st.queuedTextureOps);
        check(loaded(st), "the Vulkan renderer did not finish loading");
        std::printf(
            "%s draws %u (shadow %u, redraws %llu), items %u (culled %u), tris %u, points %u, "
            "lines %u, pipelines %u (compiling %u, failed %u), textures %u, buffers %u, "
            "gpu %.2f ms, state %llu\n",
            name.c_str(), st.drawCalls, st.shadowDrawCalls, (unsigned long long)st.shadowRedraws,
            st.drawItems, st.culledItems, st.triangles, st.points, st.lines, st.programs,
            st.programsCompiling, st.programsFailed, st.textures, st.buffers, double(st.gpuMs),
            (unsigned long long)st.stateSerial);
        check(!st.packetsRejected && !rejected, "packets rejected");
        check(!st.programsFailed, std::to_string(st.programsFailed) + " Vulkan programs failed");
        check(renderer->lastError().empty(), "renderer error: " + renderer->lastError());
        check(st.drawCalls > 0 && st.triangles > 0, "nothing was drawn");

        // ---- Read both layers back.
        vk(vkQueueWaitIdle(queue), "vkQueueWaitIdle");
        const VkDeviceSize layerBytes = VkDeviceSize(size) * size * 4;
        auto bufferInfo = vkStruct<VkBufferCreateInfo>(VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO);
        bufferInfo.size = layerBytes * 2;
        bufferInfo.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
        VkBuffer readback = VK_NULL_HANDLE;
        vk(vkCreateBuffer(device, &bufferInfo, nullptr, &readback), "vkCreateBuffer");
        VkMemoryRequirements req{};
        vkGetBufferMemoryRequirements(device, readback, &req);
        auto alloc = vkStruct<VkMemoryAllocateInfo>(VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO);
        alloc.allocationSize = req.size;
        alloc.memoryTypeIndex =
            memoryType(physical, req.memoryTypeBits,
                       VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        VkDeviceMemory readbackMemory = VK_NULL_HANDLE;
        vk(vkAllocateMemory(device, &alloc, nullptr, &readbackMemory), "vkAllocateMemory");
        vk(vkBindBufferMemory(device, readback, readbackMemory, 0), "vkBindBufferMemory");
        VkCommandBuffer copy = commands[kSlots];
        auto begin =
            vkStruct<VkCommandBufferBeginInfo>(VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO);
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        vk(vkBeginCommandBuffer(copy, &begin), "vkBeginCommandBuffer");
        VkBufferImageCopy regions[2]{};
        for (uint32_t layer = 0; layer < 2; layer++) {
            regions[layer].bufferOffset = layerBytes * layer;
            regions[layer].imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, layer, 1};
            regions[layer].imageExtent = {size, size, 1};
        }
        // The last world pass left the image in TRANSFER_SRC_OPTIMAL (its final layout).
        vkCmdCopyImageToBuffer(copy, target.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback,
                               2, regions);
        vk(vkEndCommandBuffer(copy), "vkEndCommandBuffer");
        auto submit = vkStruct<VkSubmitInfo>(VK_STRUCTURE_TYPE_SUBMIT_INFO);
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &copy;
        vk(vkQueueSubmit(queue, 1, &submit, VK_NULL_HANDLE), "vkQueueSubmit readback");
        vk(vkQueueWaitIdle(queue), "vkQueueWaitIdle readback");
        void *mapped = nullptr;
        vk(vkMapMemory(device, readbackMemory, 0, VK_WHOLE_SIZE, 0, &mapped), "vkMapMemory");
        const auto *px = static_cast<const uint8_t *>(mapped);
        writePpm(out + "/" + name + "-left.ppm", px, int(size), int(size));
        writePpm(out + "/" + name + "-right.ppm", px + layerBytes, int(size), int(size));
        vkUnmapMemory(device, readbackMemory);

        vk(vkDeviceWaitIdle(device), "vkDeviceWaitIdle");
        renderer->savePipelineCache();
        renderer.reset();
        vkDestroyBuffer(device, readback, nullptr);
        vkFreeMemory(device, readbackMemory, nullptr);
        for (VkFence f : fences)
            vkDestroyFence(device, f, nullptr);
        vkDestroyCommandPool(device, pool, nullptr);
        vkDestroyFramebuffer(device, framebuffer, nullptr);
        for (Image *i : {&target, &depth, &msaaColor}) {
            if (i->view)
                vkDestroyImageView(device, i->view, nullptr);
            if (i->image)
                vkDestroyImage(device, i->image, nullptr);
            if (i->memory)
                vkFreeMemory(device, i->memory, nullptr);
        }
        vkDestroyRenderPass(device, renderPass, nullptr);
        vkDestroyDevice(device, nullptr);
        if (debug)
            reinterpret_cast<PFN_vkDestroyDebugUtilsMessengerEXT>(vkGetInstanceProcAddr(
                instance, "vkDestroyDebugUtilsMessengerEXT"))(instance, debug, nullptr);
        vkDestroyInstance(instance, nullptr);
    } catch (const std::exception &error) {
        std::printf("FAIL: %s\n", error.what());
        failed.push_back(error.what());
    }
    std::printf("validation messages: %d\n", validationMessages);
    if (validationMessages)
        failed.push_back(std::to_string(validationMessages) + " validation messages");
    for (const std::string &what : failed)
        std::printf("failed: %s\n", what.c_str());
    std::printf(failed.empty() ? "OK\n" : "FAILED (%zu)\n", failed.size());
    return failed.empty() ? 0 : 1;
}
