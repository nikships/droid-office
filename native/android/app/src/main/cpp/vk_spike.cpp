#include "vk_spike.h"
#include "frame_metrics.h"
#include "json.hpp"
#include "log_record.h"
#include "status_layout.h"
#include "vk_spike_gpu.h"
#include "vk_spike_logic.h"
#include "xr_input.h"
#include "xr_math.h"
#include "xr_performance.h"
#include "xr_util.h"
#include <algorithm>
#include <android/log.h>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeXR", __VA_ARGS__)

// Sources for the OpenXR calls and structure chains below (local copies under research/):
//  [ETF]     research/eye-tracked-failure.md 6B: the Vulkan sequence for this runtime.
//  [GD-FOV]  Godot modules/openxr/extensions/openxr_fb_foveation_extension.cpp @084a2ca.
//  [GD-VKX]  Godot modules/openxr/extensions/platform/openxr_vulkan_extension.cpp @084a2ca.
//  [XR-FB]   XR_FB_foveation, XR_FB_foveation_configuration, XR_FB_swapchain_update_state.
//  [XR-META] XR_META_foveation_eye_tracked: "xrUpdateSwapchainFB should be called right before
//            the xrGetFoveationEyeTrackedStateMETA function".
//  [XR-METAV] XR_META_vulkan_swapchain_create_info: FEATURE_UNSUPPORTED for unsupported bits.
//  [XR-FBV]  XR_FB_foveation_vulkan: XrSwapchainImageFoveationVulkanFB in
//  xrEnumerateSwapchainImages. [XR-VK2]  XR_KHR_vulkan_enable2. The Android Surface swapchains,
//  input, refresh and metrics repeat office_xr.cpp's GLES office.

namespace office::spike {
namespace {
using Clock = std::chrono::steady_clock;

void check(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}
template <class T> T function(XrInstance instance, const char *name) {
    PFN_xrVoidFunction value = nullptr;
    check(xrGetInstanceProcAddr(instance, name, &value), name);
    return reinterpret_cast<T>(value);
}
double nowSeconds() {
    return std::chrono::duration<double>(Clock::now().time_since_epoch()).count();
}

/** Rising edge with hysteresis for analogue triggers and buttons. */
struct Edge {
    bool held = false;
    bool step(bool pressed) {
        const bool rose = pressed && !held;
        held = pressed;
        return rose;
    }
    bool stepAnalogue(float value) {
        if (!held && value > .8f) {
            held = true;
            return true;
        }
        if (held && value < .3f)
            held = false;
        return false;
    }
};

class Spike {
  public:
    explicit Spike(const Host &host)
        : host(host), env(host.env), activity(host.activity), options(parseOptions(host.options)) {}
    ~Spike();
    void init();
    void loop();

  private:
    void visibility(bool visible);
    void createSurfaceLayers();
    void createWorldSwapchain();
    void probeSubsampled();
    XrResult createProfile(XrFoveationProfileFB &out);
    void applyProfile(const char *reason);
    FoveationFrame foveationFrame(double now);
    void controls(const InputFrame &frame);
    void status(const FoveationFrame &last, bool visible);
    void report(const XrFrameState &frame, bool gazeValid);

    Host host;
    JNIEnv *env;
    jobject activity;
    Options options;
    EyeGates gates;
    Gpu gpu;
    XrInstance instance = XR_NULL_HANDLE;
    XrSystemId system = XR_NULL_SYSTEM_ID;
    XrSession session = XR_NULL_HANDLE;
    XrSpace space = XR_NULL_HANDLE, viewSpace = XR_NULL_HANDLE;
    bool floorSpace = false;
    XrSessionState state = XR_SESSION_STATE_UNKNOWN;
    bool running = false;
    XrSwapchain world = XR_NULL_HANDLE;
    uint32_t worldWidth = 0, worldHeight = 0;
    VkFormat worldFormat = VK_FORMAT_UNDEFINED;
    bool foveatedSwapchain = false, linearOutput = true;
    VkImageCreateFlags acceptedFlags = 0;
    uint32_t densityWidth = 0, densityHeight = 0;
    Msaa msaa = Msaa::Resolve4;
    int maxWidth = 0, maxHeight = 0;
    XrSwapchain panelSwapchain = XR_NULL_HANDLE, statusSwapchain = XR_NULL_HANDLE;
    bool panelVisible = false, statusVisible = true, panelPlaced = false;
    XrPosef panelPose{{0, 0, 0, 1}, {0, 0, -1.5f}};
    std::string lastStatus;
    bool lastStatusVisible = false;
    double lastStatusTime = 0;
    bool fbFoveation = false, metaEyeTracked = false, metaSwapchain = false;
    PFN_xrCreateFoveationProfileFB createFoveationProfile = nullptr;
    PFN_xrDestroyFoveationProfileFB destroyFoveationProfile = nullptr;
    PFN_xrUpdateSwapchainFB updateSwapchain = nullptr;
    PFN_xrGetFoveationEyeTrackedStateMETA eyeTrackedState = nullptr;
    XrFoveationProfileFB profile = XR_NULL_HANDLE;
    PFN_xrGetDisplayRefreshRateFB getRate = nullptr;
    PFN_xrRequestDisplayRefreshRateFB requestRate = nullptr;
    std::unique_ptr<XrInput> input;
    std::unique_ptr<RuntimePerformance> performance;
    FrameMetrics metrics;
    FoveationWindow window;
    LogGate logGate;
    FoveationFrame lastFoveation;
    double sweepStart = 0, lastFps = 0;
    uint64_t frames = 0;
    size_t roomTriangles = 0;
    bool viewFovLogged = false; // VIEW_FOV once per focus, as the GLES office logs it
    std::array<Edge, 2> trigger, primary, secondary, menu;
};

Spike::~Spike() {
    // As ~Office: the Java producers stop before their swapchains or the session go.
    visibility(false);
    gpu.waitIdle();
    if (profile)
        destroyFoveationProfile(profile);
    // Our views of the runtime's images go before the images ([XR-VK2]: the runtime owns them).
    gpu.destroyWorld();
    if (world)
        xrDestroySwapchain(world);
    if (panelSwapchain)
        xrDestroySwapchain(panelSwapchain);
    if (statusSwapchain)
        xrDestroySwapchain(statusSwapchain);
    input.reset();
    performance.reset();
    if (space)
        xrDestroySpace(space);
    if (viewSpace)
        xrDestroySpace(viewSpace);
    if (session)
        xrDestroySession(session);
    // The runtime used the device for the session's whole life; it goes only after it.
    gpu.destroyDevice();
    if (instance)
        xrDestroyInstance(instance);
}

void Spike::visibility(bool visible) {
    jclass cls = env->GetObjectClass(activity);
    env->CallVoidMethod(activity, env->GetMethodID(cls, "onSessionVisible", "(Z)V"), visible);
    env->DeleteLocalRef(cls);
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        LOG("Panel producer visibility callback failed");
    }
}

void Spike::init() {
    LOG("VK_SPIKE options=%s", describe(options).dump().c_str());
    auto initLoader = function<PFN_xrInitializeLoaderKHR>(XR_NULL_HANDLE, "xrInitializeLoaderKHR");
    auto loader = structure<XrLoaderInitInfoAndroidKHR>(XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR);
    loader.applicationVM = host.vm;
    loader.applicationContext = activity;
    check(initLoader(reinterpret_cast<XrLoaderInitInfoBaseHeaderKHR *>(&loader)),
          "initialize loader");
    uint32_t count = 0;
    check(xrEnumerateInstanceExtensionProperties(nullptr, 0, &count, nullptr), "extension count");
    std::vector<XrExtensionProperties> properties(
        count, structure<XrExtensionProperties>(XR_TYPE_EXTENSION_PROPERTIES));
    check(xrEnumerateInstanceExtensionProperties(nullptr, count, &count, properties.data()),
          "extensions");
    auto supports = [&](const char *name) {
        return std::any_of(properties.begin(), properties.end(),
                           [&](const auto &p) { return !strcmp(p.extensionName, name); });
    };
    if (!supports(XR_KHR_VULKAN_ENABLE2_EXTENSION_NAME))
        throw std::runtime_error("The runtime has no XR_KHR_vulkan_enable2");
    std::vector<const char *> extensions{XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME,
                                         XR_KHR_VULKAN_ENABLE2_EXTENSION_NAME};
    auto enable = [&](const char *name) {
        const bool ok = supports(name);
        if (ok)
            extensions.push_back(name);
        return ok;
    };
    const bool surfaces = enable(XR_KHR_ANDROID_SURFACE_SWAPCHAIN_EXTENSION_NAME);
    const bool refresh = enable(XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME);
    const bool performanceMetrics = enable(XR_ANDROID_PERFORMANCE_METRICS_EXTENSION_NAME);
    const bool performanceHints = enable(XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME);
    const bool gaze = enable(XR_EXT_EYE_GAZE_INTERACTION_EXTENSION_NAME);
    floorSpace = enable(XR_EXT_LOCAL_FLOOR_EXTENSION_NAME);
    // [GD-FOV] get_requested_extensions and is_enabled: the FB set plus XR_FB_foveation_vulkan,
    // XR_META_vulkan_swapchain_create_info and XR_META_foveation_eye_tracked for Vulkan
    // ([ETF] 6B lists the same seven). Registry dependencies: FB_foveation needs
    // swapchain_update_state; configuration and META eye tracked need FB_foveation.
    fbFoveation = supports(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME) &&
                  supports(XR_FB_FOVEATION_EXTENSION_NAME) &&
                  supports(XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME) &&
                  supports(XR_FB_FOVEATION_VULKAN_EXTENSION_NAME);
    if (fbFoveation) {
        for (const char *name :
             {XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME, XR_FB_FOVEATION_EXTENSION_NAME,
              XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME, XR_FB_FOVEATION_VULKAN_EXTENSION_NAME})
            extensions.push_back(name);
        metaEyeTracked = enable(XR_META_FOVEATION_EYE_TRACKED_EXTENSION_NAME);
    }
    metaSwapchain = enable(XR_META_VULKAN_SWAPCHAIN_CREATE_INFO_EXTENSION_NAME);
    std::string enabledText;
    for (const char *name : extensions)
        enabledText += std::string(enabledText.empty() ? "" : " ") + name;
    LOG("VK_SPIKE_EXTENSIONS %s", enabledText.c_str());

    auto android =
        structure<XrInstanceCreateInfoAndroidKHR>(XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR);
    android.applicationVM = host.vm;
    android.applicationActivity = activity;
    auto create = structure<XrInstanceCreateInfo>(XR_TYPE_INSTANCE_CREATE_INFO);
    create.next = &android;
    strcpy(create.applicationInfo.applicationName, "Droid Office XR");
    create.applicationInfo.applicationVersion = 1;
    strcpy(create.applicationInfo.engineName, "Office native Vulkan spike");
    create.applicationInfo.apiVersion = XR_API_VERSION_1_0;
    create.enabledExtensionCount = static_cast<uint32_t>(extensions.size());
    create.enabledExtensionNames = extensions.data();
    check(xrCreateInstance(&create, &instance), "create instance");
    auto runtime = structure<XrInstanceProperties>(XR_TYPE_INSTANCE_PROPERTIES);
    check(xrGetInstanceProperties(instance, &runtime), "runtime properties");
    LOG("RUNTIME %s", runtime.runtimeName);
    auto systemInfo = structure<XrSystemGetInfo>(XR_TYPE_SYSTEM_GET_INFO);
    systemInfo.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
    check(xrGetSystem(instance, &systemInfo, &system), "get system");
    // [GD-FOV] set_system_properties_and_get_next_pointer (Vulkan only).
    auto eyeProperties = structure<XrSystemFoveationEyeTrackedPropertiesMETA>(
        XR_TYPE_SYSTEM_FOVEATION_EYE_TRACKED_PROPERTIES_META);
    auto gazeProperties = structure<XrSystemEyeGazeInteractionPropertiesEXT>(
        XR_TYPE_SYSTEM_EYE_GAZE_INTERACTION_PROPERTIES_EXT);
    auto systemProperties = structure<XrSystemProperties>(XR_TYPE_SYSTEM_PROPERTIES);
    const void *chain = nullptr;
    if (gaze) {
        gazeProperties.next = const_cast<void *>(chain);
        chain = &gazeProperties;
    }
    if (metaEyeTracked) {
        eyeProperties.next = const_cast<void *>(chain);
        chain = &eyeProperties;
    }
    systemProperties.next = const_cast<void *>(chain);
    check(xrGetSystemProperties(instance, system, &systemProperties), "system properties");
    maxWidth = static_cast<int>(systemProperties.graphicsProperties.maxSwapchainImageWidth);
    maxHeight = static_cast<int>(systemProperties.graphicsProperties.maxSwapchainImageHeight);
    gates.metaExtension = metaEyeTracked && metaSwapchain;
    gates.systemSupports = metaEyeTracked && eyeProperties.supportsFoveationEyeTracked == XR_TRUE;
    gates.gazeInteraction = gaze && gazeProperties.supportsEyeGazeInteraction == XR_TRUE;
    gates.permission = options.eyePermission;
    gates.fixedRequested = options.fixed;

    msaa = options.msaa;
    gpu.createDevice(instance, system, msaa == Msaa::RenderToSingle4);
    const auto &caps = gpu.caps();
    gates.offsetFeature = caps.fragmentDensityMapOffset;
    if (msaa == Msaa::RenderToSingle4 && !caps.multisampledRenderToSingleSampled) {
        LOG("VK_MSAA_FALLBACK requested=4ms used=4 reason=no "
            "multisampledRenderToSingleSampled");
        msaa = Msaa::Resolve4;
    }
    auto capsJson = caps.json();
    capsJson["supportsFoveationEyeTracked"] = gates.systemSupports;
    capsJson["supportsEyeGazeInteraction"] = gates.gazeInteraction;
    capsJson["fbFoveation"] = fbFoveation;
    capsJson["metaFoveationEyeTracked"] = metaEyeTracked;
    capsJson["metaVulkanSwapchainCreateInfo"] = metaSwapchain;
    LOG("VK_CAPS %s", capsJson.dump().c_str());

    // [GD-VKX] set_session_create_and_get_next_pointer.
    const auto binding = gpu.binding();
    auto sessionInfo = structure<XrSessionCreateInfo>(XR_TYPE_SESSION_CREATE_INFO);
    sessionInfo.next = &binding;
    sessionInfo.systemId = system;
    check(xrCreateSession(instance, &sessionInfo, &session), "create Vulkan session");
    LOG("VK_SESSION created queueFamily=%u", binding.queueFamilyIndex);
    performance = std::make_unique<RuntimePerformance>(instance, session, performanceMetrics,
                                                       performanceHints);
    // The eye gaze action stays bound: Galaxy XR needs it for eye-tracked foveation (Godot issue
    // #113778; [GD-FOV] L213). Its pose is logged only, never used to place the fovea.
    input = std::make_unique<XrInput>(instance, session, gaze);
    auto reference = structure<XrReferenceSpaceCreateInfo>(XR_TYPE_REFERENCE_SPACE_CREATE_INFO);
    reference.referenceSpaceType =
        floorSpace ? XR_REFERENCE_SPACE_TYPE_LOCAL_FLOOR_EXT : XR_REFERENCE_SPACE_TYPE_LOCAL;
    reference.poseInReferenceSpace.orientation.w = 1;
    check(xrCreateReferenceSpace(session, &reference, &space), "create local space");
    reference.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
    check(xrCreateReferenceSpace(session, &reference, &viewSpace), "create head space");
    if (surfaces)
        createSurfaceLayers();
    else
        LOG("SURFACE_LAYERS unavailable: no XR_KHR_android_surface_swapchain");

    if (refresh) {
        auto enumerate = function<PFN_xrEnumerateDisplayRefreshRatesFB>(
            instance, "xrEnumerateDisplayRefreshRatesFB");
        getRate = function<PFN_xrGetDisplayRefreshRateFB>(instance, "xrGetDisplayRefreshRateFB");
        requestRate =
            function<PFN_xrRequestDisplayRefreshRateFB>(instance, "xrRequestDisplayRefreshRateFB");
        uint32_t rateCount = 0;
        if (XR_SUCCEEDED(enumerate(session, 0, &rateCount, nullptr))) {
            std::vector<float> rates(rateCount);
            enumerate(session, rateCount, &rateCount, rates.data());
            for (float rate : rates)
                LOG("REFRESH_AVAILABLE %.2f", rate);
        }
        LOG("REFRESH_REQUEST 90 result=%d", requestRate(session, 90));
    }

    check(xrEnumerateViewConfigurationViews(
              instance, system, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &count, nullptr),
          "view count");
    if (count != 2)
        throw std::runtime_error("Stereo views required");
    std::vector<XrViewConfigurationView> views(
        count, structure<XrViewConfigurationView>(XR_TYPE_VIEW_CONFIGURATION_VIEW));
    check(xrEnumerateViewConfigurationViews(instance, system,
                                            XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, count,
                                            &count, views.data()),
          "view configuration");
    // One multiview swapchain at the recommended eye size (the GLES default render scale 1).
    worldWidth = std::max(views[0].recommendedImageRectWidth, views[1].recommendedImageRectWidth);
    worldHeight =
        std::max(views[0].recommendedImageRectHeight, views[1].recommendedImageRectHeight);
    maxWidth = static_cast<int>(std::min(
        {views[0].maxImageRectWidth, views[1].maxImageRectWidth, static_cast<uint32_t>(maxWidth)}));
    maxHeight = static_cast<int>(std::min({views[0].maxImageRectHeight, views[1].maxImageRectHeight,
                                           static_cast<uint32_t>(maxHeight)}));

    uint32_t formatCount = 0;
    check(xrEnumerateSwapchainFormats(session, 0, &formatCount, nullptr), "format count");
    std::vector<int64_t> formats(formatCount);
    check(xrEnumerateSwapchainFormats(session, formatCount, &formatCount, formats.data()),
          "formats");
    // [GD-VKX] get_usable_swapchain_formats / hello_xr SelectColorSwapchainFormat: sRGB first so
    // the hardware encodes, as the GLES path's GL_SRGB8_ALPHA8.
    worldFormat = VK_FORMAT_UNDEFINED;
    for (VkFormat candidate : {VK_FORMAT_R8G8B8A8_SRGB, VK_FORMAT_B8G8R8A8_SRGB,
                               VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_B8G8R8A8_UNORM})
        if (worldFormat == VK_FORMAT_UNDEFINED &&
            std::find(formats.begin(), formats.end(), candidate) != formats.end())
            worldFormat = candidate;
    if (worldFormat == VK_FORMAT_UNDEFINED)
        throw std::runtime_error("No RGBA8 Vulkan swapchain format");
    linearOutput = worldFormat == VK_FORMAT_R8G8B8A8_SRGB || worldFormat == VK_FORMAT_B8G8R8A8_SRGB;

    if (fbFoveation) {
        createFoveationProfile =
            function<PFN_xrCreateFoveationProfileFB>(instance, "xrCreateFoveationProfileFB");
        destroyFoveationProfile =
            function<PFN_xrDestroyFoveationProfileFB>(instance, "xrDestroyFoveationProfileFB");
        updateSwapchain = function<PFN_xrUpdateSwapchainFB>(instance, "xrUpdateSwapchainFB");
    }
    if (metaEyeTracked)
        eyeTrackedState = function<PFN_xrGetFoveationEyeTrackedStateMETA>(
            instance, "xrGetFoveationEyeTrackedStateMETA");
    if (options.subsampledProbe)
        probeSubsampled();
    createWorldSwapchain();
    // [GD-FOV] on_main_swapchains_created -> update_profile.
    applyProfile("swapchain");
    sweepStart = nowSeconds();
}

void Spike::createSurfaceLayers() {
    // As office_xr.cpp: XR_KHR_android_surface_swapchain has no graphics-API format, so the same
    // calls work in a Vulkan session. A failure is logged and the spike continues without them.
    try {
        auto create = function<PFN_xrCreateSwapchainAndroidSurfaceKHR>(
            instance, "xrCreateSwapchainAndroidSurfaceKHR");
        auto info = structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
        info.usageFlags = XR_SWAPCHAIN_USAGE_SAMPLED_BIT;
        info.width = 2400;
        info.height = 1600;
        jobject panelSurface = nullptr;
        check(create(session, &info, &panelSwapchain, &panelSurface), "panel surface swapchain");
        jclass cls = env->GetObjectClass(activity);
        env->CallVoidMethod(activity,
                            env->GetMethodID(cls, "onPanelSurface", "(Landroid/view/Surface;II)V"),
                            panelSurface, 2400, 1600);
        env->DeleteLocalRef(cls);
        env->DeleteLocalRef(panelSurface);
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
            throw std::runtime_error("onPanelSurface failed");
        }
        // The office's status Surface (status_layout.h): a message column and a counter column,
        // each composited as its own quad.
        info.width = office::status::kWidth;
        info.height = office::status::kHeight;
        jobject statusSurface = nullptr;
        check(create(session, &info, &statusSwapchain, &statusSurface), "status surface swapchain");
        cls = env->GetObjectClass(activity);
        env->CallVoidMethod(
            activity, env->GetMethodID(cls, "onStatusSurface", "(Landroid/view/Surface;IIII)V"),
            statusSurface, office::status::kWidth, office::status::kHeight,
            office::status::kMessageWidth, office::status::kCounterLeft);
        env->DeleteLocalRef(cls);
        env->DeleteLocalRef(statusSurface);
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
            throw std::runtime_error("onStatusSurface failed");
        }
        LOG("SURFACE_LAYERS panel=1 status=1 (Vulkan session)");
    } catch (const std::exception &error) {
        LOG("SURFACE_LAYERS unavailable: %s panel=%d status=%d", error.what(),
            panelSwapchain != XR_NULL_HANDLE, statusSwapchain != XR_NULL_HANDLE);
    }
}

void Spike::probeSubsampled() {
    // Design gate (vulkan-port.md 4.4): only whether the runtime accepts a subsampled FDM
    // swapchain. VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT needs VK_EXT_fragment_density_map enabled
    // ([XR-METAV]); Godot requests it the same way (openxr_fb_foveation_extension.cpp:166-168).
    if (!fbFoveation || !metaSwapchain || !gpu.caps().fragmentDensityMap) {
        LOG("FOVEATION_VK_SUBSAMPLED_PROBE skipped fb=%d meta=%d fdm=%d", fbFoveation,
            metaSwapchain, gpu.caps().fragmentDensityMap);
        return;
    }
    auto fov =
        structure<XrSwapchainCreateInfoFoveationFB>(XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB);
    fov.flags = XR_SWAPCHAIN_CREATE_FOVEATION_FRAGMENT_DENSITY_MAP_BIT_FB;
    auto meta =
        structure<XrVulkanSwapchainCreateInfoMETA>(XR_TYPE_VULKAN_SWAPCHAIN_CREATE_INFO_META);
    meta.next = &fov;
    meta.additionalCreateFlags = VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT;
    auto info = structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
    info.next = &meta;
    info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
    info.format = worldFormat;
    info.sampleCount = 1;
    info.width = worldWidth;
    info.height = worldHeight;
    info.faceCount = 1;
    info.arraySize = 2;
    info.mipCount = 1;
    XrSwapchain probe = XR_NULL_HANDLE;
    const auto result = xrCreateSwapchain(session, &info, &probe);
    LOG("FOVEATION_VK_SUBSAMPLED_PROBE create=%d", result);
    if (probe)
        xrDestroySwapchain(probe);
}

void Spike::createWorldSwapchain() {
    const auto &caps = gpu.caps();
    foveatedSwapchain = options.foveation && fbFoveation && caps.fragmentDensityMap;
    // Without fragmentDensityMapNonSubsampledImages every attachment must be subsampled.
    const bool subsampled = foveatedSwapchain && !caps.fragmentDensityMapNonSubsampledImages;
    VkImageCreateFlags wanted = 0;
    // [GD-FOV] L160-172: the OFFSET bit when eye tracking is supported; [ETF] 6B.
    if (foveatedSwapchain && gates.metaExtension && gates.systemSupports && gates.offsetFeature)
        wanted |= VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM;
    if (subsampled)
        wanted |= VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT;
    if (msaa == Msaa::RenderToSingle4)
        wanted |= VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT;
    if (wanted && !metaSwapchain) {
        LOG("FOVEATION_VK_SWAPCHAIN no XR_META_vulkan_swapchain_create_info: flags 0x%x dropped",
            wanted);
        if (msaa == Msaa::RenderToSingle4)
            msaa = Msaa::Resolve4;
        wanted = 0;
    }
    // Attempts: everything, then without render-to-single-sampled, then without the offset bit,
    // and last a swapchain without foveation, so the session still shows the room.
    struct Attempt {
        VkImageCreateFlags flags;
        bool fdm;
    };
    std::vector<Attempt> attempts{{wanted, foveatedSwapchain}};
    if (wanted & VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT)
        attempts.push_back({wanted & ~VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT,
                            foveatedSwapchain});
    if (wanted & VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM)
        attempts.push_back(
            {attempts.back().flags & ~VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM,
             foveatedSwapchain});
    if (foveatedSwapchain)
        attempts.push_back({0, false});
    XrResult result = XR_ERROR_RUNTIME_FAILURE;
    for (const auto &attempt : attempts) {
        // [GD-FOV] set_swapchain_create_info_and_get_next_pointer: XrSwapchainCreateInfo ->
        // XrVulkanSwapchainCreateInfoMETA -> XrSwapchainCreateInfoFoveationFB.
        auto fov =
            structure<XrSwapchainCreateInfoFoveationFB>(XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB);
        fov.flags = XR_SWAPCHAIN_CREATE_FOVEATION_FRAGMENT_DENSITY_MAP_BIT_FB;
        auto meta =
            structure<XrVulkanSwapchainCreateInfoMETA>(XR_TYPE_VULKAN_SWAPCHAIN_CREATE_INFO_META);
        meta.next = attempt.fdm ? &fov : nullptr;
        meta.additionalCreateFlags = attempt.flags;
        auto info = structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
        info.next = attempt.flags ? static_cast<const void *>(&meta)
                    : attempt.fdm ? static_cast<const void *>(&fov)
                                  : nullptr;
        info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
        info.format = worldFormat;
        info.sampleCount = 1;
        info.width = worldWidth;
        info.height = worldHeight;
        info.faceCount = 1;
        info.arraySize = 2;
        info.mipCount = 1;
        result = xrCreateSwapchain(session, &info, &world);
        LOG("FOVEATION_VK_SWAPCHAIN create=%d size=%ux%u format=%d fdm=%d metaFlags=0x%x", result,
            worldWidth, worldHeight, worldFormat, attempt.fdm, attempt.flags);
        if (XR_SUCCEEDED(result)) {
            acceptedFlags = attempt.flags;
            foveatedSwapchain = attempt.fdm;
            break;
        }
        world = XR_NULL_HANDLE;
    }
    check(result, "create world swapchain");
    if (msaa == Msaa::RenderToSingle4 &&
        !(acceptedFlags & VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT)) {
        LOG("VK_MSAA_FALLBACK requested=4ms used=4 reason=swapchain refused the create bit");
        msaa = Msaa::Resolve4;
    }

    // [XR-FBV], [GD-VKX] L276-317: XrSwapchainImageFoveationVulkanFB chained on every image.
    uint32_t count = 0;
    check(xrEnumerateSwapchainImages(world, 0, &count, nullptr), "world image count");
    std::vector<XrSwapchainImageVulkanKHR> images(
        count, structure<XrSwapchainImageVulkanKHR>(XR_TYPE_SWAPCHAIN_IMAGE_VULKAN_KHR));
    std::vector<XrSwapchainImageFoveationVulkanFB> density(
        count,
        structure<XrSwapchainImageFoveationVulkanFB>(XR_TYPE_SWAPCHAIN_IMAGE_FOVEATION_VULKAN_FB));
    if (foveatedSwapchain)
        for (uint32_t i = 0; i < count; ++i)
            images[i].next = &density[i];
    check(xrEnumerateSwapchainImages(world, count, &count,
                                     reinterpret_cast<XrSwapchainImageBaseHeader *>(images.data())),
          "world images");
    WorldImages target;
    target.format = worldFormat;
    target.width = worldWidth;
    target.height = worldHeight;
    target.offsetFlag = (acceptedFlags & VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM) != 0;
    target.subsampled = (acceptedFlags & VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT) != 0;
    int missing = 0;
    for (uint32_t i = 0; i < count; ++i) {
        target.color.push_back(images[i].image);
        if (foveatedSwapchain) {
            target.density.push_back(density[i].image);
            missing += density[i].image == VK_NULL_HANDLE;
        }
    }
    if (foveatedSwapchain && count) {
        target.densityWidth = densityWidth = density[0].width;
        target.densityHeight = densityHeight = density[0].height;
    }
    LOG("FOVEATION_VK_IMAGES images=%u density=%ux%u missing=%d texel=%.2fx%.2f offsetFlag=%d "
        "subsampled=%d",
        count, densityWidth, densityHeight, missing,
        densityWidth ? static_cast<double>(worldWidth) / densityWidth : 0.,
        densityHeight ? static_cast<double>(worldHeight) / densityHeight : 0., target.offsetFlag,
        target.subsampled);
    if (missing)
        target.density.clear();
    // The floor is y = 0 in LOCAL_FLOOR; LOCAL puts the eyes near y = 0.
    const auto room = buildRoom(floorSpace ? 0.f : -1.6f);
    roomTriangles = room.indices.size() / 3;
    gpu.createWorld(target, msaa, room);
    gates.densityMap = gpu.densityMap();
    gates.swapchainOffset = target.offsetFlag;
    LOG("FOVEATION_VK_GATES eyeProfile=%d query=%d offsets=%d blockers=%s", gates.eyeProfile(),
        gates.query(), gates.offsets(), gates.blockers().c_str());
}

XrResult Spike::createProfile(XrFoveationProfileFB &out) {
    // [GD-FOV] _update_profile_rt L274-296 / [XR-FB]: profile -> level (dynamic disabled,
    // vertical offset 0) -> XrFoveationEyeTrackedProfileCreateInfoMETA (flags 0) when eye tracked.
    auto eye = structure<XrFoveationEyeTrackedProfileCreateInfoMETA>(
        XR_TYPE_FOVEATION_EYE_TRACKED_PROFILE_CREATE_INFO_META);
    eye.flags = 0;
    auto level = structure<XrFoveationLevelProfileCreateInfoFB>(
        XR_TYPE_FOVEATION_LEVEL_PROFILE_CREATE_INFO_FB);
    level.next = gates.eyeProfile() ? &eye : nullptr;
    level.level = static_cast<XrFoveationLevelFB>(std::clamp(options.level, 0, 3));
    level.verticalOffset = 0;
    level.dynamic = XR_FOVEATION_DYNAMIC_DISABLED_FB;
    auto info = structure<XrFoveationProfileCreateInfoFB>(XR_TYPE_FOVEATION_PROFILE_CREATE_INFO_FB);
    info.next = &level;
    return createFoveationProfile(session, &info, &out);
}

void Spike::applyProfile(const char *reason) {
    if (!foveatedSwapchain || !createFoveationProfile) {
        LOG("FOVEATION_VK_PROFILE reason=%s skipped foveatedSwapchain=%d fbFoveation=%d", reason,
            foveatedSwapchain, fbFoveation);
        return;
    }
    gates.fixedRequested = options.fixed;
    XrFoveationProfileFB next = XR_NULL_HANDLE;
    const auto created = createProfile(next);
    XrResult updated = XR_ERROR_HANDLE_INVALID;
    if (XR_SUCCEEDED(created)) {
        auto applied = structure<XrSwapchainStateFoveationFB>(XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB);
        applied.flags = 0;
        applied.profile = next;
        updated =
            updateSwapchain(world, reinterpret_cast<XrSwapchainStateBaseHeaderFB *>(&applied));
    }
    LOG("FOVEATION_VK_PROFILE reason=%s level=%s eyeTracked=%d profile=%s create=%d update=%d",
        reason, levelName(options.level), gates.eyeProfile(), name(options.profile), created,
        updated);
    // "A profile may be safely destroyed after being applied" ([XR-FB]); the live mode keeps one
    // for the per-frame update, the per-frame mode creates its own each frame (as Godot).
    if (profile)
        destroyFoveationProfile(profile);
    profile = XR_NULL_HANDLE;
    if (XR_SUCCEEDED(created)) {
        if (options.profile == ProfileMode::Live)
            profile = next;
        else
            destroyFoveationProfile(next);
    }
    logGate.restart();
}

FoveationFrame Spike::foveationFrame(double now) {
    FoveationFrame out;
    if (foveatedSwapchain && gates.query() && eyeTrackedState) {
        // [XR-META]: xrUpdateSwapchainFB right before xrGetFoveationEyeTrackedStateMETA, after
        // acquire and wait ([GD-FOV] L220-228). Every frame, also for offsets none/sweep, so the
        // runtime keeps its eye-tracked model and its own centre can be logged.
        XrFoveationProfileFB used = profile;
        XrFoveationProfileFB perFrame = XR_NULL_HANDLE;
        if (options.profile == ProfileMode::PerFrame) {
            out.updateResult = createProfile(perFrame);
            used = XR_SUCCEEDED(out.updateResult) ? perFrame : XR_NULL_HANDLE;
        }
        if (used) {
            auto applied =
                structure<XrSwapchainStateFoveationFB>(XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB);
            applied.flags = 0;
            applied.profile = used;
            out.updateResult =
                updateSwapchain(world, reinterpret_cast<XrSwapchainStateBaseHeaderFB *>(&applied));
        }
        out.updated = true;
        if (perFrame)
            destroyFoveationProfile(perFrame);
        auto eyes =
            structure<XrFoveationEyeTrackedStateMETA>(XR_TYPE_FOVEATION_EYE_TRACKED_STATE_META);
        out.stateResult = eyeTrackedState(session, &eyes);
        out.queried = true;
        out.flags = eyes.flags;
        out.valid = XR_SUCCEEDED(out.stateResult) &&
                    (eyes.flags & XR_FOVEATION_EYE_TRACKED_STATE_VALID_BIT_META);
        for (int i = 0; i < 2; ++i)
            out.centres[i] = {eyes.foveationCenter[i].x, eyes.foveationCenter[i].y};
    }
    if (gates.offsets()) {
        const auto &g = gpu.caps().offsetGranularity;
        const int gx = static_cast<int>(g.width), gy = static_cast<int>(g.height);
        const int w = static_cast<int>(worldWidth), h = static_cast<int>(worldHeight);
        if (options.offsets == Offsets::Eye && out.valid) {
            // [GD-FOV] L237-242: view i takes foveationCenter[i], scaled by half the target size.
            for (int i = 0; i < 2; ++i)
                out.offsets[i] =
                    centreOffset(out.centres[i][0], out.centres[i][1], options.flip, w, h, gx, gy);
            out.applied = true;
        } else if (options.offsets == Offsets::Sweep) {
            // Synthetic (design gate G-V5), in framebuffer axes: +x right, +y down.
            const auto point = sweepPoint(now - sweepStart);
            for (auto &offset : out.offsets)
                offset = centreOffset(point.x, point.y, Flip::None, w, h, gx, gy);
            out.applied = true;
        }
    }
    return out;
}

void Spike::controls(const InputFrame &frame) {
    bool changed = false, profileChanged = false;
    int hand = -1;
    const auto &left = frame.hands[0], &right = frame.hands[1];
    if (trigger[1].stepAnalogue(right.active ? right.trigger : 0)) {
        options.level = (options.level + 1) % 4;
        changed = profileChanged = true;
        hand = 1;
    }
    if (primary[1].step(right.active && right.primary)) {
        options.offsets = options.offsets == Offsets::Eye    ? Offsets::None
                          : options.offsets == Offsets::None ? Offsets::Sweep
                                                             : Offsets::Eye;
        sweepStart = nowSeconds();
        changed = true;
        hand = 1;
    }
    if (secondary[1].step(right.active && right.secondary)) {
        options.overlay = !options.overlay;
        changed = true;
        hand = 1;
    }
    if (trigger[0].stepAnalogue(left.active ? left.trigger : 0)) {
        options.fixed = !options.fixed;
        changed = profileChanged = true;
        hand = 0;
    }
    if (primary[0].step(left.active && left.primary)) {
        statusVisible = !statusVisible;
        changed = true;
        hand = 0;
    }
    if (secondary[0].step(left.active && left.secondary)) {
        options.flip = options.flip == Flip::None ? Flip::Y
                       : options.flip == Flip::Y  ? Flip::X
                       : options.flip == Flip::X  ? Flip::XY
                                                  : Flip::None;
        changed = true;
        hand = 0;
    }
    if (menu[0].step(left.active && left.menu)) {
        panelVisible = !panelVisible && panelSwapchain;
        if (panelVisible)
            panelPlaced = false;
        changed = true;
        hand = 0;
    }
    if (!changed)
        return;
    input->haptic(hand);
    LOG("VK_SPIKE_CONTROL %s panel=%d status=%d", describe(options).dump().c_str(), panelVisible,
        statusVisible);
    if (profileChanged)
        applyProfile("control");
    logGate.restart();
}

void Spike::status(const FoveationFrame &last, bool visible) {
    if (!statusSwapchain)
        return;
    const double now = nowSeconds();
    const bool show = visible && statusVisible;
    if (show == lastStatusVisible && now - lastStatusTime < .25)
        return;
    lastStatusTime = now;
    // The card shows the last FRAME_METRICS window's rate.
    const auto packet = statusPacket(options, gates, last, lastFps).dump();
    if (packet == lastStatus && show == lastStatusVisible)
        return;
    lastStatus = packet;
    lastStatusVisible = show;
    jclass cls = env->GetObjectClass(activity);
    jstring text = env->NewStringUTF(packet.c_str());
    env->CallVoidMethod(activity, env->GetMethodID(cls, "onStatus", "(Ljava/lang/String;Z)V"), text,
                        static_cast<jboolean>(show));
    env->DeleteLocalRef(text);
    env->DeleteLocalRef(cls);
}

void Spike::report(const XrFrameState &frame, bool gazeValid) {
    float refresh = 0;
    if (getRate && XR_SUCCEEDED(getRate(session, &refresh)))
        host.observedRefreshRate->store(refresh);
    auto out = nlohmann::json::parse(
        metrics.json(refresh, frame.predictedDisplayPeriod / 1e6f, gazeValid));
    out["renderer"] = "vulkan-spike";
    out["msaa"] = name(gpu.msaa());
    out["refreshRequestedHz"] = 90;
    out["sharpScreens"] = false;
    out["sharpSetting"] = false;
    out["worldRecommendedWidth"] = worldWidth;
    out["worldRecommendedHeight"] = worldHeight;
    out["worldMaxWidth"] = maxWidth;
    out["worldMaxHeight"] = maxHeight;
    out["worldWidth"] = worldWidth;
    out["worldHeight"] = worldHeight;
    out["foveationSupported"] = gpu.densityMap();
    out["foveationEnabled"] = gpu.densityMap() && options.level > 0;
    out["graphicsError"] = "";
    auto foveation = window.json();
    foveation["api"] = gpu.densityMap() ? "vulkan-fdm" : "none";
    foveation["level"] = levelName(options.level);
    foveation["eyeTracked"] = gates.eyeProfile();
    foveation["query"] = gates.query();
    foveation["offsetsMode"] = name(options.offsets);
    foveation["offsetsUsable"] = gates.offsets();
    foveation["offsetsSynthetic"] = options.offsets == Offsets::Sweep;
    foveation["flip"] = name(options.flip);
    foveation["profile"] = name(options.profile);
    foveation["granularity"] = {gpu.caps().offsetGranularity.width,
                                gpu.caps().offsetGranularity.height};
    foveation["densitySize"] = {densityWidth, densityHeight};
    foveation["subsampled"] = (acceptedFlags & VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT) != 0;
    foveation["overlay"] = options.overlay;
    foveation["blockers"] = gates.blockers();
    lastFps = out.value("fps", 0.);
    // Each line fits one log record (log_record.h): with the foveation summary inside it,
    // FRAME_METRICS passed 1023 bytes and lost its world size. The summary has its own line, as
    // the GLES office's FOVEATION_METRICS, and the pulled metrics keep it as `foveation`.
    LOG("FRAME_METRICS %s", fitLogJson(out, logJsonBudget(std::strlen("FRAME_METRICS "))).c_str());
    LOG("FOVEATION_METRICS %s",
        fitLogJson(foveation, logJsonBudget(std::strlen("FOVEATION_METRICS "))).c_str());
    auto runtime = nlohmann::json::parse(performance->sampleJson());
    nlohmann::json display = nlohmann::json::object();
    for (const char *key :
         {"/perfmetrics_android/app/cpu_frametime", "/perfmetrics_android/app/gpu_frametime",
          "/perfmetrics_android/app/motion_to_photon_latency",
          "/perfmetrics_android/compositor/frames_per_second",
          "/perfmetrics_android/compositor/dropped_frame_count",
          "/perfmetrics_android/compositor/gpu_frametime",
          "/perfmetrics_android/device/gpu_utilization"})
        if (runtime.contains(key))
            display[key] = runtime[key];
    LOG("RUNTIME_METRICS %s",
        fitLogJson(display, logJsonBudget(std::strlen("RUNTIME_METRICS "))).c_str());
    nlohmann::json scene{{"renderer", "vulkan-spike"},
                         {"objects", 4},
                         {"visible", 4},
                         {"drawCalls", options.overlay ? 2 : 1},
                         {"triangles", roomTriangles + (options.overlay ? 1 : 0)},
                         {"gpuMs", gpu.gpuMs()},
                         {"packetsApplied", 0},
                         {"pendingUploads", 0}};
    LOG("SCENE_METRICS %s",
        fitLogJson(scene, logJsonBudget(std::strlen("SCENE_METRICS "))).c_str());
    auto combined = out;
    combined["foveation"] = foveation;
    combined["runtime"] = runtime;
    combined["scene"] = scene;
    if (host.publishMetrics)
        host.publishMetrics(combined.dump(-1, ' ', true));
    window = {};
    metrics.reset();
}

void Spike::loop() {
    while (!host.stopping->load()) {
        auto event = structure<XrEventDataBuffer>(XR_TYPE_EVENT_DATA_BUFFER);
        while (xrPollEvent(instance, &event) == XR_SUCCESS) {
            if (event.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
                state = reinterpret_cast<XrEventDataSessionStateChanged *>(&event)->state;
                const bool regained = state == XR_SESSION_STATE_FOCUSED && !host.focused->load();
                if (regained)
                    viewFovLogged = false;
                host.focused->store(state == XR_SESSION_STATE_FOCUSED);
                LOG("STATE %d", state);
                visibility(state == XR_SESSION_STATE_VISIBLE || state == XR_SESSION_STATE_FOCUSED);
                if (regained && requestRate)
                    LOG("REFRESH_REQUEST_FOCUS result=%d", requestRate(session, 90));
                if (state == XR_SESSION_STATE_READY) {
                    auto begin = structure<XrSessionBeginInfo>(XR_TYPE_SESSION_BEGIN_INFO);
                    begin.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
                    check(xrBeginSession(session, &begin), "begin session");
                    performance->start();
                    running = true;
                    if (requestRate)
                        LOG("REFRESH_REQUEST_RUNNING result=%d", requestRate(session, 90));
                    // Precaution as the GLES branch: re-apply after xrBeginSession.
                    applyProfile("begin");
                } else if (state == XR_SESSION_STATE_STOPPING) {
                    check(xrEndSession(session), "end session");
                    running = false;
                } else if (state == XR_SESSION_STATE_EXITING ||
                           state == XR_SESSION_STATE_LOSS_PENDING)
                    return;
            } else if (event.type == XR_TYPE_EVENT_DATA_DISPLAY_REFRESH_RATE_CHANGED_FB) {
                auto *changed = reinterpret_cast<XrEventDataDisplayRefreshRateChangedFB *>(&event);
                LOG("REFRESH_CHANGED %.2f -> %.2f", changed->fromDisplayRefreshRate,
                    changed->toDisplayRefreshRate);
                host.observedRefreshRate->store(changed->toDisplayRefreshRate);
            } else if (event.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING)
                return;
            event = structure<XrEventDataBuffer>(XR_TYPE_EVENT_DATA_BUFFER);
        }
        if (!running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }
        auto wait = structure<XrFrameWaitInfo>(XR_TYPE_FRAME_WAIT_INFO);
        auto frame = structure<XrFrameState>(XR_TYPE_FRAME_STATE);
        check(xrWaitFrame(session, &wait, &frame), "wait frame");
        auto begin = structure<XrFrameBeginInfo>(XR_TYPE_FRAME_BEGIN_INFO);
        check(xrBeginFrame(session, &begin), "begin frame");
        const auto cpuStarted = Clock::now();
        const double now = nowSeconds();
        std::array<XrView, 2> views{structure<XrView>(XR_TYPE_VIEW),
                                    structure<XrView>(XR_TYPE_VIEW)};
        auto locate = structure<XrViewLocateInfo>(XR_TYPE_VIEW_LOCATE_INFO);
        locate.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
        locate.displayTime = frame.predictedDisplayTime;
        locate.space = space;
        auto viewState = structure<XrViewState>(XR_TYPE_VIEW_STATE);
        uint32_t count = 0;
        check(xrLocateViews(session, &locate, &viewState, 2, &count, views.data()), "locate views");
        constexpr auto validViews =
            XR_VIEW_STATE_POSITION_VALID_BIT | XR_VIEW_STATE_ORIENTATION_VALID_BIT;
        const bool poseValid = count == 2 && (viewState.viewStateFlags & validViews) == validViews;
        if (poseValid && !viewFovLogged) {
            // Each eye's FOV in degrees (left, right, down, up) and its optical axis in pixels:
            // the density map's centre without offsets, where the debug cross sits.
            viewFovLogged = true;
            constexpr float degrees = 57.2957795f;
            std::array<std::array<float, 2>, 2> axis{};
            for (int i = 0; i < 2; ++i) {
                const auto &fov = views[i].fov;
                axis[i] =
                    opticalAxisPixel(static_cast<int>(worldWidth), static_cast<int>(worldHeight),
                                     std::tan(fov.angleLeft), std::tan(fov.angleRight),
                                     std::tan(fov.angleDown), std::tan(fov.angleUp));
            }
            const auto &l = views[0].fov, &r = views[1].fov;
            LOG("VIEW_FOV left=%.2f,%.2f,%.2f,%.2f right=%.2f,%.2f,%.2f,%.2f axis0=(%.1f,%.1f) "
                "axis1=(%.1f,%.1f) image=%ux%u",
                l.angleLeft * degrees, l.angleRight * degrees, l.angleDown * degrees,
                l.angleUp * degrees, r.angleLeft * degrees, r.angleRight * degrees,
                r.angleDown * degrees, r.angleUp * degrees, axis[0][0], axis[0][1], axis[1][0],
                axis[1][1], worldWidth, worldHeight);
        }
        const bool focused = host.focused->load();
        XrPosef head = views[0].pose;
        head.position = scale(add(views[0].pose.position, views[1].pose.position), .5f);
        auto inputFrame = input->sample(space, frame.predictedDisplayTime, head);
        if (focused && poseValid)
            controls(inputFrame);
        XrPosef gazePose;
        const bool gazeValid = input->gazePose(space, frame.predictedDisplayTime, gazePose);
        std::array<std::array<float, 2>, 2> gaze{};
        if (gazeValid)
            for (int i = 0; i < 2; ++i) {
                const auto d = rotate(conjugate(views[i].pose.orientation),
                                      rotate(gazePose.orientation, {0, 0, -1}));
                gaze[i] = gazeNdc(d.x, d.y, d.z, std::tan(views[i].fov.angleLeft),
                                  std::tan(views[i].fov.angleRight),
                                  std::tan(views[i].fov.angleDown), std::tan(views[i].fov.angleUp));
            }
        const bool valid = frame.shouldRender && poseValid;
        FoveationFrame foveation;
        std::array<XrCompositionLayerProjectionView, 2> projectionViews{};
        if (valid) {
            uint32_t imageIndex = 0;
            auto acquire =
                structure<XrSwapchainImageAcquireInfo>(XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
            check(xrAcquireSwapchainImage(world, &acquire, &imageIndex), "acquire world");
            auto imageWait = structure<XrSwapchainImageWaitInfo>(XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
            imageWait.timeout = XR_INFINITE_DURATION;
            check(xrWaitSwapchainImage(world, &imageWait), "wait world");
            // [ETF] 6B per frame: acquire, wait, xrUpdateSwapchainFB, the eye state, then record
            // the pass (the host reads the density map at vkCmdBeginRenderPass).
            foveation = foveationFrame(now);
            RecordInput record;
            for (int i = 0; i < 2; ++i) {
                const auto projection = office::projection(views[i].fov, .05f, 100.f);
                const auto viewProj = multiply(projection, inverse(views[i].pose));
                std::copy(viewProj.begin(), viewProj.end(), record.uniforms.viewProj[i]);
                // The cross marks the density map's centre: this eye's optical axis plus the
                // applied offset (none: the axis itself).
                const auto &fov = views[i].fov;
                const auto axis =
                    opticalAxisPixel(static_cast<int>(worldWidth), static_cast<int>(worldHeight),
                                     std::tan(fov.angleLeft), std::tan(fov.angleRight),
                                     std::tan(fov.angleDown), std::tan(fov.angleUp));
                const auto marker =
                    markerPixel(foveation.applied ? foveation.offsets[i] : Offset{}, axis);
                record.uniforms.marker[i][0] = marker[0];
                record.uniforms.marker[i][1] = marker[1];
                record.uniforms.marker[i][2] = gpu.densityMap() ? 1.f : 0.f;
            }
            record.uniforms.viewport[0] = static_cast<float>(worldWidth);
            record.uniforms.viewport[1] = static_cast<float>(worldHeight);
            record.uniforms.viewport[2] = .5f;
            record.uniforms.viewport[3] = linearOutput ? 0.f : 1.f;
            const float eyeY = floorSpace ? 1.6f : 0.f;
            record.uniforms.rings[0] = 0;
            record.uniforms.rings[1] = eyeY;
            record.uniforms.rings[2] = RoomLayout::front;
            record.uniforms.rings[3] = -RoomLayout::front;
            record.uniforms.light[0] = .3f;
            record.uniforms.light[1] = .8f;
            record.uniforms.light[2] = .5f;
            record.uniforms.light[3] = .55f;
            record.overlay = options.overlay;
            record.applyOffsets = foveation.applied;
            record.offsets = foveation.offsets;
            gpu.render(imageIndex, record);
            // Released after the submit that references it ([XR-VK2] "Swapchain Image Layout").
            auto release =
                structure<XrSwapchainImageReleaseInfo>(XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
            check(xrReleaseSwapchainImage(world, &release), "release world");
            for (int i = 0; i < 2; ++i) {
                auto &pv = projectionViews[i];
                pv = structure<XrCompositionLayerProjectionView>(
                    XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW);
                pv.pose = views[i].pose;
                pv.fov = views[i].fov;
                pv.subImage.swapchain = world;
                pv.subImage.imageArrayIndex = static_cast<uint32_t>(i);
                pv.subImage.imageRect.offset = {0, 0};
                pv.subImage.imageRect.extent = {static_cast<int32_t>(worldWidth),
                                                static_cast<int32_t>(worldHeight)};
            }
            window.add(foveation);
            lastFoveation = foveation;
            int64_t signature = (foveation.queried ? 1 : 0) | (foveation.valid ? 2 : 0) |
                                (foveation.applied ? 4 : 0) |
                                (static_cast<int64_t>(foveation.flags & 0xff) << 3) |
                                (static_cast<int64_t>(foveation.updateResult & 0xffff) << 12) |
                                (static_cast<int64_t>(foveation.stateResult & 0xffff) << 28);
            if (logGate.shouldLog(now, signature))
                LOG("FOVEATION_VK frame=%llu level=%s profile=%s offsets=%s%s flip=%s queried=%d "
                    "update=%d state=%d flags=0x%llx valid=%d centre0=(%.4f,%.4f) "
                    "centre1=(%.4f,%.4f) applied=%d offset0=(%d,%d) offset1=(%d,%d) gaze=%d "
                    "gazeNdc0=(%.4f,%.4f) gazeNdc1=(%.4f,%.4f)",
                    static_cast<unsigned long long>(frames), levelName(options.level),
                    gates.eyeProfile() ? "eye-tracked" : "fixed", name(options.offsets),
                    options.offsets == Offsets::Sweep ? "(synthetic)" : "", name(options.flip),
                    foveation.queried, foveation.updateResult, foveation.stateResult,
                    static_cast<unsigned long long>(foveation.flags), foveation.valid,
                    foveation.centres[0][0], foveation.centres[0][1], foveation.centres[1][0],
                    foveation.centres[1][1], foveation.applied, foveation.offsets[0].x,
                    foveation.offsets[0].y, foveation.offsets[1].x, foveation.offsets[1].y,
                    gazeValid, gaze[0][0], gaze[0][1], gaze[1][0], gaze[1][1]);
            ++frames;
        }
        if (panelVisible && !panelPlaced && valid) {
            const auto forward = rotate(head.orientation, {0, 0, -1});
            panelPose.orientation = yaw(std::atan2(-forward.x, -forward.z));
            panelPose.position =
                add(head.position, rotate(panelPose.orientation, {0, -.1f, -1.5f}));
            panelPlaced = true;
        }
        status(lastFoveation, focused && valid);
        auto projection =
            structure<XrCompositionLayerProjection>(XR_TYPE_COMPOSITION_LAYER_PROJECTION);
        projection.space = space;
        projection.viewCount = 2;
        projection.views = projectionViews.data();
        auto panel = structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
        panel.space = space;
        panel.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
        panel.pose = panelPose;
        panel.size = {1.8f, 1.2f};
        panel.subImage.swapchain = panelSwapchain;
        panel.subImage.imageRect.extent = {2400, 1600};
        auto statusLayer = structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
        statusLayer.space = viewSpace;
        statusLayer.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
        statusLayer.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
        statusLayer.pose = office::status::kMessagePose;
        statusLayer.size = office::status::kMessageSize;
        statusLayer.subImage.swapchain = statusSwapchain;
        statusLayer.subImage.imageRect = {{0, 0},
                                          {office::status::kMessageWidth, office::status::kHeight}};
        // The spike's settings line (the packet's "aim") is drawn in the counter column.
        auto statusCounter = statusLayer;
        statusCounter.pose = office::status::counterPose();
        statusCounter.size = office::status::kCounterSize;
        statusCounter.subImage.imageRect = {
            {office::status::kCounterLeft, 0},
            {office::status::kCounterWidth, office::status::kHeight}};
        std::vector<const XrCompositionLayerBaseHeader *> layers;
        if (valid) {
            layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&projection));
            if (panelVisible && panelSwapchain)
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&panel));
        }
        // As the GLES office: drain the status BufferQueue until the UI thread acknowledges that
        // its producer stopped, even while the world is invalid.
        if (statusSwapchain && host.statusProducerVisible->load()) {
            layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&statusLayer));
            layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&statusCounter));
        }
        auto end = structure<XrFrameEndInfo>(XR_TYPE_FRAME_END_INFO);
        end.displayTime = frame.predictedDisplayTime;
        end.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
        end.layerCount = static_cast<uint32_t>(layers.size());
        end.layers = layers.data();
        check(xrEndFrame(session, &end), "end frame");
        const double cpuMs =
            std::chrono::duration<double, std::milli>(Clock::now() - cpuStarted).count();
        metrics.submit(valid, state == XR_SESSION_STATE_FOCUSED, frame.predictedDisplayTime,
                       frame.predictedDisplayPeriod, cpuMs);
        if (metrics.ready())
            report(frame, gazeValid);
    }
}
} // namespace

void run(const Host &host) {
    Spike spike(host);
    spike.init();
    spike.loop();
}

} // namespace office::spike
