#pragma once
// Vulkan half of the debug-only foveation spike: the VkInstance and VkDevice created through
// XR_KHR_vulkan_enable2, and the multiview world pass that renders into the runtime's
// fragment-density-mapped swapchain. Compiled only with OFFICE_VULKAN_SPIKE and
// XR_USE_GRAPHICS_API_VULKAN (see CMakeLists.txt).
#include "vk_spike_logic.h"
// openxr_platform.h needs the types of every platform and graphics API the target defines
// (XR_USE_PLATFORM_ANDROID, XR_USE_GRAPHICS_API_OPENGL_ES and, here, _VULKAN).
#include <EGL/egl.h>
#include <jni.h>
#include <vulkan/vulkan.h>
// clang-format off
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
// clang-format on
#include "controller_model.h"
#include "vk_scene_renderer.h"
#include <android/asset_manager.h>
#include <array>
#include <functional>
namespace office {
struct WorldFrame;
}
#include <string>
#include <vector>

namespace office::spike {

/** std140 Frame block of shaders/vk/room.vert, room.frag and overlay.frag. */
struct FrameUniforms {
    float viewProj[2][16];
    float viewport[4];
    float marker[2][4];
    float rings[4];
    float light[4];
};
static_assert(sizeof(FrameUniforms) == 208, "matches the std140 Frame block");

struct DeviceCaps {
    uint32_t instanceVersion = 0, deviceVersion = 0, vendorId = 0, deviceId = 0, driverVersion = 0;
    std::string deviceName;
    uint64_t xrMinVersion = 0, xrMaxVersion = 0;
    bool fdmExtension = false, fdmOffsetExtension = false, msrtssExtension = false;
    bool renderPass2Core = false, renderPass2Extension = false;
    bool multiview = false, fragmentDensityMap = false, fragmentDensityMapDynamic = false,
         fragmentDensityMapNonSubsampledImages = false, fragmentDensityMapOffset = false,
         multisampledRenderToSingleSampled = false;
    VkExtent2D minTexel{}, maxTexel{}, offsetGranularity{};
    bool densityInvocations = false;
    bool lazilyAllocated = false;
    uint32_t timestampValidBits = 0;
    float timestampPeriod = 0;
    uint32_t maxMultiviewViewCount = 0;
    VkSampleCountFlags colorSamples = 0, depthSamples = 0;
    VkFormat depthFormat = VK_FORMAT_UNDEFINED;
    uint32_t queueFamily = 0;
    std::vector<std::string> instanceLayers;
    nlohmann::json json() const;
};

/** The world swapchain as xrEnumerateSwapchainImages returned it. */
struct WorldImages {
    VkFormat format = VK_FORMAT_UNDEFINED;
    uint32_t width = 0, height = 0;
    std::vector<VkImage> color;
    /** XrSwapchainImageFoveationVulkanFB images, one per colour image, or empty. */
    std::vector<VkImage> density;
    uint32_t densityWidth = 0, densityHeight = 0;
    /** VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM was requested through
     *  XrVulkanSwapchainCreateInfoMETA and accepted. */
    bool offsetFlag = false;
    bool subsampled = false;
};

struct RecordInput {
    const WorldFrame *officeFrame = nullptr;
    FrameUniforms uniforms{};
    bool overlay = true;
    bool applyOffsets = false;
    std::array<Offset, 2> offsets{};
};

class Gpu {
  public:
    Gpu() = default;
    Gpu(const Gpu &) = delete;
    Gpu &operator=(const Gpu &) = delete;
    ~Gpu();

    /** xrGetVulkanGraphicsRequirements2KHR, xrCreateVulkanInstanceKHR,
     *  xrGetVulkanGraphicsDevice2KHR and xrCreateVulkanDeviceKHR; call before xrCreateSession. */
    void createDevice(XrInstance instance, XrSystemId system, bool wantRenderToSingle);
    XrGraphicsBindingVulkanKHR binding() const;
    const DeviceCaps &caps() const { return deviceCaps; }

    /** Render pass, transient attachments, framebuffers and pipelines for these images. */
    void createWorld(const WorldImages &images, Msaa msaa, const RoomMesh &mesh);
    void destroyWorld();
    bool densityMap() const { return !densityViews.empty(); }
    Msaa msaa() const { return worldMsaa; }

    /** Waits for the frame slot, records the world pass into colour image `index`, ending it
     *  with the density map offsets when asked, and submits it to the session's queue. Call
     *  between xrWaitSwapchainImage and xrReleaseSwapchainImage on the render thread. */
    void render(uint32_t index, const RecordInput &input);
    void initializeControllers(AAssetManager *assets);
    VkSceneDevice sceneDevice() const;
    VkSceneTarget sceneTarget() const;
    void renderScene(uint32_t index, const RecordInput &input, VkSceneRenderer &scene,
                     const SceneEye eyes[2], const SceneControllerPoses &poses);

    /** GPU time of the last world pass whose timestamps are available, or -1. */
    double gpuMs() const { return lastGpuMs; }
    void waitIdle();
    /** After xrDestroySession: the runtime uses the device for as long as the session lives. */
    void destroyDevice();

  private:
    void record(uint32_t index, const RecordInput &input, VkSceneRenderer *scene,
                const SceneEye *eyes, const SceneControllerPoses *poses);
    static constexpr uint32_t Slots = 3;
    struct Allocation {
        VkImage image = VK_NULL_HANDLE;
        VkDeviceMemory memory = VK_NULL_HANDLE;
        VkImageView view = VK_NULL_HANDLE;
    };
    struct Buffer {
        VkBuffer buffer = VK_NULL_HANDLE;
        VkDeviceMemory memory = VK_NULL_HANDLE;
        void *mapped = nullptr;
    };
    struct NativeController {
        ControllerModel model;
        Buffer vertices, indices;
        std::vector<Matrix> transforms;
    };
    struct InputPush {
        Matrix model;
        float color[4];
        float mode[4];
    };
    std::array<NativeController, 2> controllers;
    Buffer inputVertices;
    VkPipeline nativePipeline = VK_NULL_HANDLE, panelPipeline = VK_NULL_HANDLE,
               fadePipeline = VK_NULL_HANDLE;
    void drawNative(VkCommandBuffer cmd, uint32_t slot, const RecordInput &input,
                    VkSceneRenderer &scene);
    uint32_t memoryType(uint32_t allowed, VkMemoryPropertyFlags required,
                        VkMemoryPropertyFlags preferred) const;
    Allocation attachment(VkFormat format, VkSampleCountFlagBits samples, VkImageUsageFlags usage,
                          VkImageCreateFlags flags, VkImageAspectFlags aspect);
    Buffer hostBuffer(VkDeviceSize size, VkBufferUsageFlags usage);
    void destroy(Allocation &allocation);
    void destroy(Buffer &buffer);
    VkImageView arrayView(VkImage image, VkFormat format, VkImageAspectFlags aspect);
    VkPipeline pipeline(const uint32_t *vertex, size_t vertexBytes, const uint32_t *fragment,
                        size_t fragmentBytes, bool room, VkSampleCountFlagBits samples,
                        bool panel = false);

    DeviceCaps deviceCaps;
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    VkPhysicalDeviceMemoryProperties memory{};
    PFN_vkCreateRenderPass2 createRenderPass2 = nullptr;
    PFN_vkCmdEndRenderPass2 endRenderPass2 = nullptr;
    bool offsetFeatureEnabled = false, renderToSingleEnabled = false;

    WorldImages world;
    Msaa worldMsaa = Msaa::Resolve4;
    VkRenderPass renderPass = VK_NULL_HANDLE;
    Allocation msaaColor, depth;
    std::vector<VkImageView> colorViews, densityViews;
    std::vector<bool> densityReady;
    std::vector<VkFramebuffer> framebuffers;
    uint32_t attachmentCount = 0;
    VkDescriptorSetLayout setLayout = VK_NULL_HANDLE;
    VkDescriptorPool descriptorPool = VK_NULL_HANDLE;
    std::array<VkDescriptorSet, Slots> sets{};
    VkPipelineLayout layout = VK_NULL_HANDLE;
    VkPipeline roomPipeline = VK_NULL_HANDLE, overlayPipeline = VK_NULL_HANDLE;
    Buffer uniforms, vertices, indices;
    VkDeviceSize uniformStride = 0;
    uint32_t indexCount = 0;
    VkCommandPool commandPool = VK_NULL_HANDLE;
    std::array<VkCommandBuffer, Slots> commands{};
    std::array<VkFence, Slots> fences{};
    std::array<VkQueryPool, Slots> queries{};
    std::array<bool, Slots> queryPending{};
    uint64_t frame = 0;
    double lastGpuMs = -1;
};

} // namespace office::spike
