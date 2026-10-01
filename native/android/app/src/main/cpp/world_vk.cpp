// The installed office uses Vulkan exclusively. Bring-up and FDM chains follow the verified
// vk_spike and Khronos XR_KHR_vulkan_enable2 / XR_FB_foveation_vulkan /
// XR_META_foveation_eye_tracked.
#include "world_vk.h"
#include "controller_attachment.h"
#include "foveation.h"
#include "vk_scene_renderer.h"
#include "vk_spike_gpu.h"
#include "xr_call.h"
#include "xr_math.h"
#include "xr_util.h"
#include <algorithm>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <chrono>
#include <cstring>
#include <stdexcept>

namespace office {
namespace {
using xr::check;
using xr::function;
using Clock = std::chrono::steady_clock;
class VulkanWorld final : public WorldRenderer {
    WorldHost host;
    spike::Gpu gpu;
    XrInstance instance = XR_NULL_HANDLE;
    XrSystemId system = XR_NULL_SYSTEM_ID;
    XrSession session = XR_NULL_HANDLE;
    XrSwapchain world = XR_NULL_HANDLE;
    XrFoveationProfileFB profile = XR_NULL_HANDLE;
    XrGraphicsBindingVulkanKHR binding{};
    XrSystemFoveationEyeTrackedPropertiesMETA eyeProperties{};
    PFN_xrCreateFoveationProfileFB createProfile = nullptr;
    PFN_xrDestroyFoveationProfileFB destroyFoveation = nullptr;
    PFN_xrUpdateSwapchainFB updateProfile = nullptr;
    PFN_xrGetFoveationEyeTrackedStateMETA getEyeState = nullptr;
    std::unique_ptr<VkSceneRenderer> scene;
    std::array<ResolutionLimits, 2> limits{};
    GraphicsControls bound{};
    RenderTargetChanges changes;
    uint32_t width = 0, height = 0;
    VkFormat format = VK_FORMAT_UNDEFINED;
    uint64_t validFrames = 0, invalidFrames = 0;
    bool eyeValid = false;
    std::array<XrVector2f, 2> centers{};
    std::string error;
    bool activeFoveation() const { return bound.foveation != FoveationQuality::Off; }
    void applyProfile() {
        if (!profile)
            return;
        auto state = structure<XrSwapchainStateFoveationFB>(XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB);
        state.profile = profile;
        check(updateProfile(world, reinterpret_cast<XrSwapchainStateBaseHeaderFB *>(&state)),
              "apply Vulkan eye-tracked foveation");
    }
    void replaceTargets(const GraphicsControls &settings) {
        const auto size = renderSize(limits[0], settings.renderScale);
        const bool foveated = settings.foveation != FoveationQuality::Off;
        const auto &caps = gpu.caps();
        auto foveation =
            structure<XrSwapchainCreateInfoFoveationFB>(XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB);
        foveation.flags = XR_SWAPCHAIN_CREATE_FOVEATION_FRAGMENT_DENSITY_MAP_BIT_FB;
        auto meta =
            structure<XrVulkanSwapchainCreateInfoMETA>(XR_TYPE_VULKAN_SWAPCHAIN_CREATE_INFO_META);
        meta.next = &foveation;
        meta.additionalCreateFlags = VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM;
        const bool subsampled = foveated && !caps.fragmentDensityMapNonSubsampledImages;
        if (subsampled)
            meta.additionalCreateFlags |= VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT;
        auto info = structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
        info.next = foveated ? &meta : nullptr;
        info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
        info.format = format;
        info.sampleCount = 1;
        info.width = size.width;
        info.height = size.height;
        info.faceCount = 1;
        info.arraySize = 2;
        info.mipCount = 1;
        XrSwapchain next = XR_NULL_HANDLE;
        XrFoveationProfileFB nextProfile = XR_NULL_HANDLE;
        try {
            check(xrCreateSwapchain(session, &info, &next), "create Vulkan office swapchain");
            uint32_t count = 0;
            check(xrEnumerateSwapchainImages(next, 0, &count, nullptr), "Vulkan image count");
            std::vector<XrSwapchainImageVulkanKHR> images(
                count, structure<XrSwapchainImageVulkanKHR>(XR_TYPE_SWAPCHAIN_IMAGE_VULKAN_KHR));
            std::vector<XrSwapchainImageFoveationVulkanFB> densities(
                count, structure<XrSwapchainImageFoveationVulkanFB>(
                           XR_TYPE_SWAPCHAIN_IMAGE_FOVEATION_VULKAN_FB));
            for (uint32_t i = 0; foveated && i < count; ++i)
                images[i].next = &densities[i];
            check(xrEnumerateSwapchainImages(
                      next, count, &count,
                      reinterpret_cast<XrSwapchainImageBaseHeader *>(images.data())),
                  "Vulkan images");
            spike::WorldImages target;
            target.format = format;
            target.width = size.width;
            target.height = size.height;
            target.offsetFlag = foveated;
            target.subsampled = subsampled;
            for (uint32_t i = 0; i < count; ++i) {
                target.color.push_back(images[i].image);
                if (foveated) {
                    if (!densities[i].image || !densities[i].width || !densities[i].height)
                        throw std::runtime_error(
                            "Runtime did not supply a Vulkan fragment density map");
                    target.density.push_back(densities[i].image);
                    target.densityWidth = densities[i].width;
                    target.densityHeight = densities[i].height;
                }
            }
            if (foveated) {
                auto eye = structure<XrFoveationEyeTrackedProfileCreateInfoMETA>(
                    XR_TYPE_FOVEATION_EYE_TRACKED_PROFILE_CREATE_INFO_META);
                auto level = structure<XrFoveationLevelProfileCreateInfoFB>(
                    XR_TYPE_FOVEATION_LEVEL_PROFILE_CREATE_INFO_FB);
                level.next = &eye;
                level.level = static_cast<XrFoveationLevelFB>(foveationLevel(settings.foveation));
                level.dynamic = XR_FOVEATION_DYNAMIC_DISABLED_FB;
                auto create = structure<XrFoveationProfileCreateInfoFB>(
                    XR_TYPE_FOVEATION_PROFILE_CREATE_INFO_FB);
                create.next = &level;
                check(createProfile(session, &create, &nextProfile), "create eye-tracked profile");
                auto state =
                    structure<XrSwapchainStateFoveationFB>(XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB);
                state.profile = nextProfile;
                check(updateProfile(next, reinterpret_cast<XrSwapchainStateBaseHeaderFB *>(&state)),
                      "apply eye-tracked profile");
            }
            // No acquired images. Complete old commands before releasing targets (XR-VK2).
            gpu.waitIdle();
            scene->releaseTarget();
            gpu.destroyWorld();
            gpu.createWorld(target, spike::Msaa::Resolve4, spike::buildRoom(0));
            scene->setTarget(gpu.sceneTarget());
            destroyProfile();
            if (world)
                check(xrDestroySwapchain(world), "destroy old Vulkan targets");
            world = next;
            profile = nextProfile;
            next = XR_NULL_HANDLE;
            nextProfile = XR_NULL_HANDLE;
            width = size.width;
            height = size.height;
            bound = settings;
            error.clear();
            host.editMetrics([&](nlohmann::json &m) {
                addFrameMetrics(m);
                m["foveation"] = currentFoveation();
            });
        } catch (...) {
            if (nextProfile)
                destroyFoveation(nextProfile);
            if (next)
                xrDestroySwapchain(next);
            throw; // Report the requested Vulkan failure; never select another renderer or mode.
        }
    }
    nlohmann::json currentFoveation() const {
        return {{"setting", foveationQualityName(bound.foveation)},
                {"level", activeFoveation() ? foveationQualityName(bound.foveation) : "none"},
                {"mode", activeFoveation() ? "eye-tracked" : "off"},
                {"eyeTracked", activeFoveation()},
                {"eyeTrackedAvailable", true},
                {"centerValid", eyeValid},
                {"center", {{centers[0].x, centers[0].y}, {centers[1].x, centers[1].y}}},
                {"validFrames", validFrames},
                {"invalidFrames", invalidFrames},
                {"pending", false},
                {"filtered", false},
                {"fallback", ""}};
    }

  public:
    explicit VulkanWorld(const WorldHost &h) : host(h) {}
    ~VulkanWorld() override { gpu.destroyDevice(); }
    const char *graphicsExtension() const override { return XR_KHR_VULKAN_ENABLE2_EXTENSION_NAME; }
    void instanceExtensions(const std::function<bool(const char *)> &supports, bool gaze,
                            std::vector<const char *> &extensions) override {
        if (!gaze)
            throw std::runtime_error("Vulkan eye-tracked rendering requires eye gaze support");
        for (const char *name :
             {XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME, XR_FB_FOVEATION_EXTENSION_NAME,
              XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME, XR_FB_FOVEATION_VULKAN_EXTENSION_NAME,
              XR_META_FOVEATION_EYE_TRACKED_EXTENSION_NAME,
              XR_META_VULKAN_SWAPCHAIN_CREATE_INFO_EXTENSION_NAME}) {
            if (!supports(name))
                throw std::runtime_error(std::string("Required Vulkan extension: ") + name);
            extensions.push_back(name);
        }
    }
    void *systemProperties(void *next) override {
        eyeProperties = structure<XrSystemFoveationEyeTrackedPropertiesMETA>(
            XR_TYPE_SYSTEM_FOVEATION_EYE_TRACKED_PROPERTIES_META);
        eyeProperties.next = next;
        return &eyeProperties;
    }
    const void *createDevice(XrInstance xrInstance, XrSystemId xrSystem, const XrSystemProperties &,
                             bool gaze) override {
        instance = xrInstance;
        system = xrSystem;
        if (!gaze || !eyeProperties.supportsFoveationEyeTracked)
            throw std::runtime_error("Runtime does not support Vulkan eye-tracked foveation");
        createProfile =
            function<PFN_xrCreateFoveationProfileFB>(instance, "xrCreateFoveationProfileFB");
        destroyFoveation =
            function<PFN_xrDestroyFoveationProfileFB>(instance, "xrDestroyFoveationProfileFB");
        updateProfile = function<PFN_xrUpdateSwapchainFB>(instance, "xrUpdateSwapchainFB");
        getEyeState = function<PFN_xrGetFoveationEyeTrackedStateMETA>(
            instance, "xrGetFoveationEyeTrackedStateMETA");
        gpu.createDevice(instance, system, false);
        const auto &caps = gpu.caps();
        if (!caps.fragmentDensityMap || !caps.fragmentDensityMapOffset)
            throw std::runtime_error("Vulkan device lacks fragment density map offsets");
        binding = gpu.binding();
        return &binding;
    }
    void createTargets(XrSession xrSession, const std::vector<XrViewConfigurationView> &views,
                       const XrSystemProperties &) override {
        session = xrSession;
        const auto device = gpu.sceneDevice();
        VkPhysicalDeviceProperties properties{};
        vkGetPhysicalDeviceProperties(device.physical, &properties);
        for (int i = 0; i < 2; ++i) {
            limits[i] = {{static_cast<int>(views[i].recommendedImageRectWidth),
                          static_cast<int>(views[i].recommendedImageRectHeight)},
                         {static_cast<int>(std::min(views[i].maxImageRectWidth,
                                                    properties.limits.maxImageDimension2D)),
                          static_cast<int>(std::min(views[i].maxImageRectHeight,
                                                    properties.limits.maxImageDimension2D))}};
        }
        limits[0].maximum.width = std::min(limits[0].maximum.width, limits[1].maximum.width);
        limits[0].maximum.height = std::min(limits[0].maximum.height, limits[1].maximum.height);
        uint32_t count = 0;
        check(xrEnumerateSwapchainFormats(session, 0, &count, nullptr), "Vulkan format count");
        std::vector<int64_t> formats(count);
        check(xrEnumerateSwapchainFormats(session, count, &count, formats.data()),
              "Vulkan formats");
        format = VK_FORMAT_R8G8B8A8_SRGB;
        if (std::find(formats.begin(), formats.end(), format) == formats.end())
            throw std::runtime_error("Runtime does not offer the office's Vulkan sRGB format");
        scene = std::make_unique<VkSceneRenderer>();
        if (!scene->initialize(device, 3))
            throw std::runtime_error(scene->lastError());
        jclass cls = host.env->GetObjectClass(host.activity);
        jobject assets = host.env->CallObjectMethod(
            host.activity,
            host.env->GetMethodID(cls, "getAssets", "()Landroid/content/res/AssetManager;"));
        gpu.initializeControllers(AAssetManager_fromJava(host.env, assets));
        host.env->DeleteLocalRef(assets);
        host.env->DeleteLocalRef(cls);
        const auto settings = host.startGraphics();
        replaceTargets(settings);
        RenderTargetRequest current;
        current.size[0] = {static_cast<int>(width), static_cast<int>(height)};
        current.foveation.level = foveationLevel(settings.foveation);
        changes.reset(current);
    }
    void enqueueScene(const std::string &packet) override { scene->enqueueJson(packet); }
    bool acceptsScene() override { return scene->acceptsPackets(); }
    bool takeSceneReset() override { return scene->takeResetRequest(); }
    void sessionBegun() override { applyProfile(); }
    void updateTargets(const GraphicsControls &settings, double now, bool mayReplace) override {
        RenderTargetRequest desired;
        const auto size = renderSize(limits[0], settings.renderScale);
        desired.size[0] = size;
        desired.foveation.level = foveationLevel(settings.foveation);
        if (changes.observe(desired, now) && mayReplace) {
            replaceTargets(settings);
            changes.finish(desired, true);
        }
    }
    bool render(const WorldFrame &frame,
                std::array<XrCompositionLayerProjectionView, 2> &projection,
                std::array<XrCompositionLayerProjectionView, 2> &) override {
        if (!frame.valid)
            return false;
        uint32_t index = 0;
        auto acquire = structure<XrSwapchainImageAcquireInfo>(XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
        auto wait = structure<XrSwapchainImageWaitInfo>(XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
        wait.timeout = XR_INFINITE_DURATION;
        check(xrAcquireSwapchainImage(world, &acquire, &index), "acquire Vulkan world");
        check(xrWaitSwapchainImage(world, &wait), "wait Vulkan world");
        spike::RecordInput draw;
        draw.overlay = false;
        draw.officeFrame = &frame;
        for (int i = 0; i < 2; ++i) {
            const auto pv = multiply(office::projection((*frame.views)[i].fov, .05f, 320.f),
                                     inverse((*frame.views)[i].pose));
            std::copy(pv.begin(), pv.end(), draw.uniforms.viewProj[i]);
        }
        eyeValid = false;
        centers = {};
        if (activeFoveation()) {
            // META requires the profile update immediately before querying this frame's centre.
            applyProfile();
            auto state =
                structure<XrFoveationEyeTrackedStateMETA>(XR_TYPE_FOVEATION_EYE_TRACKED_STATE_META);
            check(getEyeState(session, &state), "query Vulkan eye-tracked foveation");
            eyeValid = (state.flags & XR_FOVEATION_EYE_TRACKED_STATE_VALID_BIT_META) != 0;
            if (eyeValid) {
                ++validFrames;
                for (int i = 0; i < 2; ++i)
                    centers[i] = state.foveationCenter[i];
            } else
                ++invalidFrames;
            draw.applyOffsets = true;
            for (int i = 0; i < 2; ++i)
                draw.offsets[i] = spike::centreOffset(
                    centers[i].x, centers[i].y, spike::Flip::None, width, height,
                    gpu.caps().offsetGranularity.width, gpu.caps().offsetGranularity.height);
        }
        SceneEye eyes[2];
        const auto rigView = inverseRigid(frame.controls->rig);
        for (int i = 0; i < 2; ++i) {
            const auto p = office::projection((*frame.views)[i].fov, .05f, 320.f);
            const auto v = multiply(inverse((*frame.views)[i].pose), rigView);
            std::copy(p.begin(), p.end(), eyes[i].projection);
            std::copy(v.begin(), v.end(), eyes[i].view);
        }
        AttachmentFrame attach;
        attach.focused = frame.focused;
        attach.poseValid = frame.poseValid;
        attach.shouldRender = frame.shouldRender;
        attach.controlsActive = frame.controls->active;
        attach.nowNs =
            std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch())
                .count();
        attach.receivedNs = frame.controls->receivedNs;
        gpu.renderScene(index, draw, *scene, eyes,
                        attachmentPoses(*frame.input, frame.controls->rig, attach));
        auto release = structure<XrSwapchainImageReleaseInfo>(XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
        check(xrReleaseSwapchainImage(world, &release), "release Vulkan world");
        for (int i = 0; i < 2; ++i) {
            projection[i] = structure<XrCompositionLayerProjectionView>(
                XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW);
            projection[i].pose = (*frame.views)[i].pose;
            projection[i].fov = (*frame.views)[i].fov;
            projection[i].subImage.swapchain = world;
            projection[i].subImage.imageArrayIndex = i;
            projection[i].subImage.imageRect = {
                {0, 0}, {static_cast<int>(width), static_cast<int>(height)}};
        }
        return false;
    }
    XrCompositionLayerQuad cursorLayer(XrSpace space, XrPosef pose) const override {
        auto layer = structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
        layer.space = space;
        layer.pose = pose;
        return layer;
    }
    unsigned attachedHands() const override { return scene ? scene->attachedHands() : 0; }
    size_t attachedBounds(float (*out)[4], size_t max) const override {
        return scene ? scene->attachedBounds(out, max) : 0;
    }
    void addFrameMetrics(nlohmann::json &m) override {
        m["renderer"] = "vulkan";
        m["worldWidth"] = width;
        m["worldHeight"] = height;
        // limits[0] is the left eye's recommendation, bounded by both eyes' runtime maximum and
        // the Vulkan image limit; renderSize allocates from exactly these.
        m["worldRecommendedWidth"] = limits[0].recommended.width;
        m["worldRecommendedHeight"] = limits[0].recommended.height;
        m["worldMaxWidth"] = limits[0].maximum.width;
        m["worldMaxHeight"] = limits[0].maximum.height;
        m["maxRenderScale"] = maximumRenderScale(limits[0]);
        m["foveationSupported"] = true;
        m["foveationEnabled"] = activeFoveation();
        m["foveationLevel"] = foveationQualityName(bound.foveation);
        m["graphicsError"] = error;
        m["sharpScreens"] = false;
    }
    nlohmann::json foveationMetrics(const GraphicsControls &) override {
        const auto report = currentFoveation();
        validFrames = invalidFrames = 0;
        return report;
    }
    SceneStats sceneStats() const override { return scene ? scene->stats() : SceneStats{}; }
    std::string frameMetricsSuffix() override { return " renderer=vulkan"; }
    void finishGpuWork() override {
        gpu.waitIdle();
        if (scene) {
            scene->savePipelineCache();
            scene.reset();
        }
    }
    void destroyProfile() override {
        if (profile)
            destroyFoveation(profile);
        profile = XR_NULL_HANDLE;
    }
    void destroyTargets() override {
        gpu.destroyWorld();
        if (world)
            xrDestroySwapchain(world);
        world = XR_NULL_HANDLE;
    }
};
} // namespace
std::unique_ptr<WorldRenderer> makeVulkanWorld(const WorldHost &host) {
    return std::make_unique<VulkanWorld>(host);
}
} // namespace office
