#include "bridge_state.h"
#include "capture_puppet.h"
#include "foveation.h"
#include "frame_metrics.h"
#include "json.hpp"
#include "layer_occlusion.h"
#include "log_record.h"
#include "native_settings.h"
#include "panel_pointer.h"
#include "refresh_policy.h"
#include "rig_presentation.h"
#include "status_layout.h"
#ifdef OFFICE_VULKAN_SPIKE
#include "vk_spike.h"
#endif
#include "world_renderer.h"
#include "world_vk.h"
#include "xr_call.h"
#include "xr_input.h"
#include "xr_math.h"
#include "xr_performance.h"
#include "xr_util.h"
// OpenXR platform bindings require the graphics API types before openxr_platform.h.
#include <EGL/egl.h>
#include <vulkan/vulkan.h>

#include <algorithm>
#include <android/log.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <functional>
#include <jni.h>
#include <memory>
#include <mutex>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeXR", __VA_ARGS__)

namespace {
using Clock = std::chrono::steady_clock;
JavaVM *vm = nullptr;
std::thread renderThread;
std::atomic<bool> stopping{false};
std::atomic<bool> focused{false}, rebaseRequested{false};
std::atomic<bool> overlayOpen{false};
// The APK's settings view (NativeSettingsView.java). The left Menu edge toggles it on the display
// thread; the view's own buttons close it from the UI thread. settingsHandoff: the view closed to
// show the page's workspace, so the quad stays up until the page reports it open.
std::atomic<bool> settingsOpen{false}, settingsHandoff{false};
// Debug builds only: capturePuppetEnabled(BuildConfig.DEBUG) from the Java host.
std::atomic<bool> puppetEnabled{false};
// Keep consuming the status BufferQueue until the UI thread acknowledges that its producer
// stopped. Otherwise a pending Canvas dequeue can block that thread, freezing office updates.
std::atomic<bool> statusProducerVisible{false};
std::mutex inputMutex;
std::vector<office::InputFrame> inputFrames;
office::BridgeState bridge;
std::mutex sceneConsumerMutex;
std::function<void(const std::string &)> sceneConsumer;
std::function<bool()> sceneAccepts, sceneResetNeeded;
std::deque<std::string> scenePending;
size_t scenePendingBytes = 0;
std::mutex metricsMutex;
std::string latestMetrics = "{}";
std::atomic<int64_t> lastControlReceiptNs{0};
std::atomic<uint64_t> controlHeartbeats{0};
std::atomic<float> observedRefreshRate{0};
// Debug builds only: set by nativeSelectRenderer right before nativeStart and consumed by it.
std::string rendererOptions;
// The page's render scale and foveation from the last launch (office::storedGraphics), in the
// app's private files directory, so the first world targets are created with them.
std::mutex graphicsStoreMutex;
std::string graphicsStorePath;

bool readStoredGraphics(office::GraphicsControls &graphics) {
    std::string path;
    {
        std::lock_guard<std::mutex> lock(graphicsStoreMutex);
        path = graphicsStorePath;
    }
    if (path.empty())
        return false;
    std::ifstream in(path);
    if (!in)
        return false;
    std::stringstream text;
    text << in.rdbuf();
    return office::restoreGraphics(text.str(), graphics);
}

/**
 * Bridge or settings-store worker only, never the display loop. Taking and writing under one
 * lock keeps the file in the order the settings changed, whichever thread writes.
 */
void persistGraphics() {
    std::lock_guard<std::mutex> lock(graphicsStoreMutex);
    office::GraphicsControls graphics;
    if (graphicsStorePath.empty() || !bridge.takeStoredGraphics(graphics))
        return;
    const auto staged = graphicsStorePath + ".tmp";
    {
        std::ofstream out(staged, std::ios::trunc);
        out << office::storedGraphics(graphics);
        if (!out) {
            LOG("GRAPHICS_STORE_FAILED write %s", staged.c_str());
            return;
        }
    }
    if (std::rename(staged.c_str(), graphicsStorePath.c_str()) != 0)
        LOG("GRAPHICS_STORE_FAILED rename %s", graphicsStorePath.c_str());
}

void resetControlHeartbeat() {
    lastControlReceiptNs = 0;
    controlHeartbeats = 0;
}

void controlHeartbeatMetrics(nlohmann::json &metrics) {
    const auto received = lastControlReceiptNs.load();
    metrics["controlHeartbeats"] = controlHeartbeats.load();
    if (!received) {
        metrics["controlAgeMs"] = nullptr;
        return;
    }
    const auto now =
        std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch())
            .count();
    metrics["controlAgeMs"] = std::clamp((now - received) / 1e6, 0., 60000.);
}

/** The metrics the page pulls, with the live focus, heartbeat and refresh rate. */
std::string currentMetrics() {
    nlohmann::json metrics;
    {
        std::lock_guard<std::mutex> lock(metricsMutex);
        metrics = nlohmann::json::parse(latestMetrics);
    }
    // Focus is live: a sleeping headset has no new frame report to replace its last FPS.
    metrics["focused"] = focused.load();
    // Fresh age and observed refresh reveal stalls or downgrades between frame reports.
    controlHeartbeatMetrics(metrics);
    const float refresh = observedRefreshRate.load();
    if (refresh > 0)
        metrics["refresh"] = refresh;
    return metrics.dump(-1, ' ', true);
}

using office::xr::check;
using office::xr::function;
using office::xr::optionalFunction;

class Office {
  public:
    JNIEnv *env;
    jobject activity;
    XrInstance instance = XR_NULL_HANDLE;
    XrSystemId system = XR_NULL_SYSTEM_ID;
    XrSession session = XR_NULL_HANDLE;
    XrSpace space = XR_NULL_HANDLE;
    XrSpace viewSpace = XR_NULL_HANDLE;
    XrReferenceSpaceType referenceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
    XrSwapchain panelSwapchain = XR_NULL_HANDLE;
    XrSwapchain statusSwapchain = XR_NULL_HANDLE;
    std::string previousStatus;
    bool previousStatusVisible = false;
    office::status::CounterReveal counterReveal;
    XrPosef panelPose{{0, 0, 0, 1}, {0, 0, -1.5f}};
    bool panelPlaced = false;
    bool previousPanelOpen = true;
    office::PanelPointer pointer;
    office::SettingsMenuButton settingsButton;
    office::WorkspacePanel workspacePanel;
    std::array<XrPosef, 2> cursorPose{};
    std::array<bool, 2> cursorVisible{};
    float scrollTime = 0;
    XrSessionState state = XR_SESSION_STATE_UNKNOWN;
    bool running = false;
    XrTime spaceChangeTime = 0;
    bool viewFovLogged = false;
    PFN_xrGetDisplayRefreshRateFB getRate = nullptr;
    PFN_xrRequestDisplayRefreshRateFB requestRate = nullptr;
    office::RefreshPolicy refreshPolicy;
    double lastRateCheckMs = -1000;
    uint32_t refreshRequests = 0;
    std::unique_ptr<office::XrInput> input;
    // XR_KHR_composition_layer_color_scale_bias: the status card fades out while a hand is in
    // front of it (layer_occlusion.h). Without it the card stays drawn over the hand.
    bool colorScaleBias = false;
    office::StatusYield statusYield;
    std::unique_ptr<office::RuntimePerformance> performance;
    // Everything the graphics API draws (world_renderer.h); Vulkan: world_vk.cpp.
    std::unique_ptr<office::WorldRenderer> renderer;

    Office(JNIEnv *e, jobject a) : env(e), activity(a) {
        office::WorldHost host;
        host.env = e;
        host.activity = a;
        // The stored copy was seeded when the display thread started (nativeStart), before the
        // settings view could open, so a choice made since then is already in the bridge.
        host.startGraphics = [] {
            const auto startGraphics = bridge.graphics();
            LOG("GRAPHICS_START owner=host renderScale=%.3f foveation=%s fps=%d",
                startGraphics.renderScale, office::foveationQualityName(startGraphics.foveation),
                startGraphics.fps);
            return startGraphics;
        };
        host.editMetrics = [](const std::function<void(nlohmann::json &)> &edit) {
            std::lock_guard<std::mutex> lock(metricsMutex);
            auto metrics = nlohmann::json::parse(latestMetrics, nullptr, false);
            if (!metrics.is_object())
                metrics = nlohmann::json::object();
            edit(metrics);
            latestMetrics = metrics.dump(-1, ' ', true);
        };
        renderer = office::makeVulkanWorld(host);
    }

    ~Office() {
        // The Java producers must stop before their runtime swapchains are destroyed,
        // including an exception during initialization or an instance-loss event.
        visibility(false);
        {
            std::lock_guard<std::mutex> lock(sceneConsumerMutex);
            sceneConsumer = {};
            sceneAccepts = {};
            sceneResetNeeded = {};
            scenePending.clear();
            scenePendingBytes = 0;
        }
        // Complete image use before any teardown that destroys a runtime swapchain,
        // including the cursor (WorldRenderer::finishGpuWork).
        if (renderer)
            renderer->finishGpuWork();
        input.reset();
        performance.reset();
        if (renderer)
            renderer->destroyProfile();
        if (panelSwapchain)
            xrDestroySwapchain(panelSwapchain);
        if (statusSwapchain)
            xrDestroySwapchain(statusSwapchain);
        if (renderer)
            renderer->destroyTargets();
        if (space)
            xrDestroySpace(space);
        if (viewSpace)
            xrDestroySpace(viewSpace);
        if (session)
            xrDestroySession(session);
        if (instance)
            xrDestroyInstance(instance);
        // The graphics device last, after the instance, as before the seam.
        renderer.reset();
    }

    void visibility(bool visible) {
        jclass cls = env->GetObjectClass(activity);
        env->CallVoidMethod(activity, env->GetMethodID(cls, "onSessionVisible", "(Z)V"), visible);
        env->DeleteLocalRef(cls);
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            LOG("Panel producer visibility callback failed");
        }
    }

    void init() {
        auto initLoader =
            function<PFN_xrInitializeLoaderKHR>(XR_NULL_HANDLE, "xrInitializeLoaderKHR");
        auto loader =
            office::structure<XrLoaderInitInfoAndroidKHR>(XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR);
        loader.applicationVM = vm;
        loader.applicationContext = activity;
        check(initLoader(reinterpret_cast<XrLoaderInitInfoBaseHeaderKHR *>(&loader)),
              "initialize loader");
        uint32_t count = 0;
        check(xrEnumerateInstanceExtensionProperties(nullptr, 0, &count, nullptr),
              "extension count");
        std::vector<XrExtensionProperties> properties(
            count, office::structure<XrExtensionProperties>(XR_TYPE_EXTENSION_PROPERTIES));
        check(xrEnumerateInstanceExtensionProperties(nullptr, count, &count, properties.data()),
              "extensions");
        for (auto &p : properties)
            LOG("EXT %s", p.extensionName);
        auto supports = [&](const char *name) {
            return std::any_of(properties.begin(), properties.end(),
                               [&](const auto &p) { return !strcmp(p.extensionName, name); });
        };
        std::vector<const char *> extensions{XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME,
                                             renderer->graphicsExtension()};
        if (supports(XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME))
            extensions.push_back(XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME);
        const bool performanceMetrics = supports(XR_ANDROID_PERFORMANCE_METRICS_EXTENSION_NAME);
        const bool performanceHints = supports(XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME);
        if (performanceMetrics)
            extensions.push_back(XR_ANDROID_PERFORMANCE_METRICS_EXTENSION_NAME);
        if (performanceHints)
            extensions.push_back(XR_EXT_PERFORMANCE_SETTINGS_EXTENSION_NAME);
        extensions.push_back(XR_KHR_ANDROID_SURFACE_SWAPCHAIN_EXTENSION_NAME);
        const bool gaze = supports(XR_EXT_EYE_GAZE_INTERACTION_EXTENSION_NAME);
        const bool floor = supports(XR_EXT_LOCAL_FLOOR_EXTENSION_NAME);
        if (gaze)
            extensions.push_back(XR_EXT_EYE_GAZE_INTERACTION_EXTENSION_NAME);
        if (floor)
            extensions.push_back(XR_EXT_LOCAL_FLOOR_EXTENSION_NAME);
        // The renderer's own extensions (Vulkan: eye-tracked foveation).
        renderer->instanceExtensions(supports, gaze, extensions);
        colorScaleBias = supports(XR_KHR_COMPOSITION_LAYER_COLOR_SCALE_BIAS_EXTENSION_NAME);
        if (colorScaleBias)
            extensions.push_back(XR_KHR_COMPOSITION_LAYER_COLOR_SCALE_BIAS_EXTENSION_NAME);
        auto android = office::structure<XrInstanceCreateInfoAndroidKHR>(
            XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR);
        android.applicationVM = vm;
        android.applicationActivity = activity;
        auto create = office::structure<XrInstanceCreateInfo>(XR_TYPE_INSTANCE_CREATE_INFO);
        create.next = &android;
        strcpy(create.applicationInfo.applicationName, "Droid Office XR");
        create.applicationInfo.applicationVersion = 1;
        strcpy(create.applicationInfo.engineName, "Office native");
        create.applicationInfo.apiVersion = XR_API_VERSION_1_0;
        create.enabledExtensionCount = extensions.size();
        create.enabledExtensionNames = extensions.data();
        check(xrCreateInstance(&create, &instance), "create instance");
        auto runtime = office::structure<XrInstanceProperties>(XR_TYPE_INSTANCE_PROPERTIES);
        check(xrGetInstanceProperties(instance, &runtime), "runtime properties");
        LOG("RUNTIME %s", runtime.runtimeName);
        LOG("INPUT_SCHEME motion_controllers handTracking=0 workspace=left_menu");
        auto systemInfo = office::structure<XrSystemGetInfo>(XR_TYPE_SYSTEM_GET_INFO);
        systemInfo.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
        check(xrGetSystem(instance, &systemInfo, &system), "get system");
        auto systemProperties = office::structure<XrSystemProperties>(XR_TYPE_SYSTEM_PROPERTIES);
        // Only structs of enabled extensions may extend XrSystemProperties.
        auto gazeProperties = office::structure<XrSystemEyeGazeInteractionPropertiesEXT>(
            XR_TYPE_SYSTEM_EYE_GAZE_INTERACTION_PROPERTIES_EXT);
        if (gaze) {
            gazeProperties.next = systemProperties.next;
            systemProperties.next = &gazeProperties;
        }
        // The renderer's own (GLES: XrSystemFoveationEyeTrackedPropertiesMETA).
        systemProperties.next = renderer->systemProperties(systemProperties.next);
        check(xrGetSystemProperties(instance, system, &systemProperties), "system properties");
        const void *graphicsBinding =
            renderer->createDevice(instance, system, systemProperties,
                                   gaze && gazeProperties.supportsEyeGazeInteraction == XR_TRUE);
        auto sessionInfo = office::structure<XrSessionCreateInfo>(XR_TYPE_SESSION_CREATE_INFO);
        sessionInfo.next = graphicsBinding;
        sessionInfo.systemId = system;
        check(xrCreateSession(instance, &sessionInfo, &session), "create session");
        performance = std::make_unique<office::RuntimePerformance>(
            instance, session, performanceMetrics, performanceHints);
        input = std::make_unique<office::XrInput>(instance, session, gaze);
        auto reference =
            office::structure<XrReferenceSpaceCreateInfo>(XR_TYPE_REFERENCE_SPACE_CREATE_INFO);
        reference.referenceSpaceType =
            floor ? XR_REFERENCE_SPACE_TYPE_LOCAL_FLOOR_EXT : XR_REFERENCE_SPACE_TYPE_LOCAL;
        referenceType = reference.referenceSpaceType;
        reference.poseInReferenceSpace.orientation.w = 1;
        check(xrCreateReferenceSpace(session, &reference, &space), "create local space");
        reference.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
        check(xrCreateReferenceSpace(session, &reference, &viewSpace), "create head space");
        auto panelInfo = office::structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
        panelInfo.usageFlags = XR_SWAPCHAIN_USAGE_SAMPLED_BIT;
        panelInfo.width = 2400;
        panelInfo.height = 1600;
        // Android chooses the producer format. The extension requires format/sampleCount/
        // faceCount/arraySize/mipCount to remain zero (unlike a projection swapchain).
        jobject panelSurface = nullptr;
        check(function<PFN_xrCreateSwapchainAndroidSurfaceKHR>(
                  instance, "xrCreateSwapchainAndroidSurfaceKHR")(session, &panelInfo,
                                                                  &panelSwapchain, &panelSurface),
              "create Android panel swapchain");
        jclass activityClass = env->GetObjectClass(activity);
        jmethodID onSurface =
            env->GetMethodID(activityClass, "onPanelSurface", "(Landroid/view/Surface;II)V");
        env->CallVoidMethod(activity, onSurface, panelSurface, 2400, 1600);
        env->DeleteLocalRef(activityClass);
        env->DeleteLocalRef(panelSurface);
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
            throw std::runtime_error("Unable to create workspace panel");
        }
        panelInfo.width = office::status::kWidth;
        panelInfo.height = office::status::kHeight;
        jobject statusSurface = nullptr;
        check(function<PFN_xrCreateSwapchainAndroidSurfaceKHR>(
                  instance, "xrCreateSwapchainAndroidSurfaceKHR")(session, &panelInfo,
                                                                  &statusSwapchain, &statusSurface),
              "create status swapchain");
        activityClass = env->GetObjectClass(activity);
        env->CallVoidMethod(
            activity,
            env->GetMethodID(activityClass, "onStatusSurface", "(Landroid/view/Surface;IIII)V"),
            statusSurface, office::status::kWidth, office::status::kHeight,
            office::status::kMessageWidth, office::status::kCounterLeft);
        env->DeleteLocalRef(activityClass);
        env->DeleteLocalRef(statusSurface);
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
            throw std::runtime_error("Unable to create status panel");
        }
        if (supports(XR_FB_DISPLAY_REFRESH_RATE_EXTENSION_NAME)) {
            auto enumerate = function<PFN_xrEnumerateDisplayRefreshRatesFB>(
                instance, "xrEnumerateDisplayRefreshRatesFB");
            getRate =
                function<PFN_xrGetDisplayRefreshRateFB>(instance, "xrGetDisplayRefreshRateFB");
            requestRate = function<PFN_xrRequestDisplayRefreshRateFB>(
                instance, "xrRequestDisplayRefreshRateFB");
            check(enumerate(session, 0, &count, nullptr), "refresh rate count");
            std::vector<float> rates(count);
            check(enumerate(session, count, &count, rates.data()), "refresh rates");
            for (float rate : rates)
                LOG("REFRESH_AVAILABLE %.2f", rate);
            if (std::none_of(rates.begin(), rates.end(),
                             [](float rate) { return std::abs(rate - 90) < .1f; }))
                throw std::runtime_error(
                    "This runtime does not offer the required 90 Hz display mode");
            auto result = requestRate(session, 90);
            ++refreshRequests;
            check(result, "request 90 Hz display mode");
            LOG("REFRESH_REQUEST 90 result=%d", result);
        }
        check(xrEnumerateViewConfigurationViews(
                  instance, system, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &count, nullptr),
              "view count");
        if (count != 2)
            throw std::runtime_error("Stereo views required");
        std::vector<XrViewConfigurationView> views(
            count, office::structure<XrViewConfigurationView>(XR_TYPE_VIEW_CONFIGURATION_VIEW));
        check(xrEnumerateViewConfigurationViews(instance, system,
                                                XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, count,
                                                &count, views.data()),
              "view configuration");
        renderer->createTargets(session, views, systemProperties);
        LOG("LAYER_OCCLUSION panel=underlay statusFade=%d", colorScaleBias);
        {
            std::lock_guard<std::mutex> lock(sceneConsumerMutex);
            sceneConsumer = [this](const std::string &packet) { renderer->enqueueScene(packet); };
            sceneAccepts = [this] { return renderer->acceptsScene(); };
            sceneResetNeeded = [this] { return renderer->takeSceneReset(); };
            for (const auto &packet : scenePending)
                sceneConsumer(packet);
            scenePending.clear();
            scenePendingBytes = 0;
        }
    }

    void loop() {
        office::FrameMetrics metrics;
        office::PanelHover hover;
        office::RigPresentation presentation;
        unsigned puppetHands = 0;
        while (!stopping) {
            auto event = office::structure<XrEventDataBuffer>(XR_TYPE_EVENT_DATA_BUFFER);
            while (xrPollEvent(instance, &event) == XR_SUCCESS) {
                if (event.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
                    state = reinterpret_cast<XrEventDataSessionStateChanged *>(&event)->state;
                    const bool regainedFocus = state == XR_SESSION_STATE_FOCUSED && !focused;
                    if (regainedFocus) {
                        rebaseRequested = true;
                        presentation.reset();
                        refreshPolicy.reset();
                        lastRateCheckMs = -1000;
                        viewFovLogged = false;
                    }
                    focused = state == XR_SESSION_STATE_FOCUSED;
                    LOG("STATE %d", state);
                    const bool visible =
                        state == XR_SESSION_STATE_VISIBLE || state == XR_SESSION_STATE_FOCUSED;
                    visibility(visible);
                    // Restore the app's 90 Hz preference after a system UI/focus transition.
                    if (regainedFocus && requestRate && getRate) {
                        float rate = 0;
                        const auto queried = getRate(session, &rate);
                        if (XR_SUCCEEDED(queried) && std::isfinite(rate)) {
                            observedRefreshRate = rate;
                            if (std::abs(rate - 90) >= .1f) {
                                const auto requested = requestRate(session, 90);
                                ++refreshRequests;
                                LOG("REFRESH_REQUEST_FOCUS from=%.2f target=90 result=%d", rate,
                                    requested);
                            }
                        } else if (XR_FAILED(queried))
                            LOG("REFRESH_QUERY_FOCUS result=%d", queried);
                    }
                    if (state == XR_SESSION_STATE_READY) {
                        auto begin =
                            office::structure<XrSessionBeginInfo>(XR_TYPE_SESSION_BEGIN_INFO);
                        begin.primaryViewConfigurationType =
                            XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
                        check(xrBeginSession(session, &begin), "begin session");
                        performance->start();
                        running = true;
                        renderer->sessionBegun();
                        if (requestRate) {
                            auto result = requestRate(session, 90);
                            ++refreshRequests;
                            check(result, "request running 90 Hz display mode");
                            LOG("REFRESH_REQUEST_RUNNING result=%d", result);
                        }
                    } else if (state == XR_SESSION_STATE_STOPPING) {
                        check(xrEndSession(session), "end session");
                        running = false;
                    } else if (state == XR_SESSION_STATE_EXITING ||
                               state == XR_SESSION_STATE_LOSS_PENDING)
                        return;
                } else if (event.type == XR_TYPE_EVENT_DATA_DISPLAY_REFRESH_RATE_CHANGED_FB) {
                    auto *changed =
                        reinterpret_cast<XrEventDataDisplayRefreshRateChangedFB *>(&event);
                    LOG("REFRESH_CHANGED %.2f -> %.2f", changed->fromDisplayRefreshRate,
                        changed->toDisplayRefreshRate);
                    observedRefreshRate = changed->toDisplayRefreshRate;
                } else if (event.type == XR_TYPE_EVENT_DATA_PERF_SETTINGS_EXT) {
                    auto *changed = reinterpret_cast<XrEventDataPerfSettingsEXT *>(&event);
                    LOG("PERFORMANCE_EVENT domain=%d subdomain=%d from=%d to=%d", changed->domain,
                        changed->subDomain, changed->fromLevel, changed->toLevel);
                } else if (event.type == XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING) {
                    auto *changed =
                        reinterpret_cast<XrEventDataReferenceSpaceChangePending *>(&event);
                    if (changed->referenceSpaceType == referenceType)
                        spaceChangeTime = changed->changeTime;
                    LOG("REFERENCE_SPACE_CHANGE type=%d valid=%d", changed->referenceSpaceType,
                        changed->poseValid);
                } else if (event.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING)
                    return;
                event = office::structure<XrEventDataBuffer>(XR_TYPE_EVENT_DATA_BUFFER);
            }
            if (!running) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
            auto wait = office::structure<XrFrameWaitInfo>(XR_TYPE_FRAME_WAIT_INFO);
            auto frame = office::structure<XrFrameState>(XR_TYPE_FRAME_STATE);
            check(xrWaitFrame(session, &wait, &frame), "wait frame");
            auto begin = office::structure<XrFrameBeginInfo>(XR_TYPE_FRAME_BEGIN_INFO);
            check(xrBeginFrame(session, &begin), "begin frame");
            auto cpuStarted = Clock::now();
            const double nowMs =
                std::chrono::duration<double, std::milli>(cpuStarted.time_since_epoch()).count();
            if (requestRate && getRate && nowMs - lastRateCheckMs >= 1000) {
                lastRateCheckMs = nowMs;
                float rate = 0;
                if (XR_SUCCEEDED(getRate(session, &rate))) {
                    observedRefreshRate = rate;
                    if (refreshPolicy.shouldRequest(nowMs, rate, focused)) {
                        const auto requested = requestRate(session, 90);
                        ++refreshRequests;
                        LOG("REFRESH_PREFERENCE from=%.2f target=90 result=%d attempt=%u", rate,
                            requested, refreshRequests);
                    }
                }
            }
            std::array<XrView, 2> views{office::structure<XrView>(XR_TYPE_VIEW),
                                        office::structure<XrView>(XR_TYPE_VIEW)};
            auto locate = office::structure<XrViewLocateInfo>(XR_TYPE_VIEW_LOCATE_INFO);
            locate.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
            locate.displayTime = frame.predictedDisplayTime;
            locate.space = space;
            auto viewState = office::structure<XrViewState>(XR_TYPE_VIEW_STATE);
            uint32_t count = 0;
            check(xrLocateViews(session, &locate, &viewState, 2, &count, views.data()),
                  "locate views");
            constexpr auto validViews =
                XR_VIEW_STATE_POSITION_VALID_BIT | XR_VIEW_STATE_ORIENTATION_VALID_BIT;
            constexpr auto trackedViews =
                XR_VIEW_STATE_POSITION_TRACKED_BIT | XR_VIEW_STATE_ORIENTATION_TRACKED_BIT;
            bool poseValid = count == 2 && (viewState.viewStateFlags & validViews) == validViews;
            if (poseValid && !viewFovLogged) {
                // Each eye's field of view in degrees (left, right, down, up), to place the
                // runtime's foveation pattern and the reported centre relative to the view axis
                // in captures of the diagnostic view.
                viewFovLogged = true;
                constexpr float degrees = 57.2957795f;
                const auto &l = views[0].fov, &r = views[1].fov;
                LOG("VIEW_FOV left=%.2f,%.2f,%.2f,%.2f right=%.2f,%.2f,%.2f,%.2f",
                    l.angleLeft * degrees, l.angleRight * degrees, l.angleDown * degrees,
                    l.angleUp * degrees, r.angleLeft * degrees, r.angleRight * degrees,
                    r.angleDown * degrees, r.angleUp * degrees);
            }
            if (spaceChangeTime && frame.predictedDisplayTime >= spaceChangeTime) {
                spaceChangeTime = 0;
                presentation.reset();
                panelPlaced = false;
                rebaseRequested = true;
                std::lock_guard<std::mutex> lock(inputMutex);
                inputFrames.clear();
            }
            XrPosef head = views[0].pose;
            head.position =
                office::scale(office::add(views[0].pose.position, views[1].pose.position), .5f);
            office::InputFrame inputFrame = input->sample(space, frame.predictedDisplayTime, head);
            inputFrame.headTracked =
                focused && poseValid && (viewState.viewStateFlags & trackedViews) == trackedViews;
            if (!focused || !poseValid)
                for (auto &hand : inputFrame.hands)
                    hand.active = false;
            auto controls = bridge.read();
            if constexpr (office::kCapturePuppetBuild) {
                // Debug builds only: synthetic controllers fill untracked slots before the
                // pointer, models, rays, attachments and the page's samples read this frame.
                office::PuppetFrame puppetFrame;
                puppetFrame.enabled = puppetEnabled;
                puppetFrame.tracking = focused && poseValid;
                puppetFrame.nowNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        Clock::now().time_since_epoch())
                                        .count();
                puppetFrame.receivedNs = controls.receivedNs;
                puppetFrame.head = head;
                const auto driven = office::applyPuppet(inputFrame, controls.puppet, puppetFrame);
                if (driven != puppetHands) {
                    puppetHands = driven;
                    LOG("CAPTURE_PUPPET hands=%u (synthetic input)", driven);
                }
            }
            // The left Menu button opens and closes the APK's settings view here, without the
            // page. Its samples (below) never carry the button, so no page toggles anything too.
            if (settingsButton.step(inputFrame.hands[0].active, inputFrame.hands[0].menu)) {
                const bool open = !settingsOpen.load();
                settingsOpen = open;
                if (open)
                    settingsHandoff = false;
                input->haptic(0);
                LOG("NATIVE_SETTINGS open=%d source=left_menu", open);
                jclass cls = env->GetObjectClass(activity);
                env->CallVoidMethod(activity, env->GetMethodID(cls, "onNativeSettings", "(Z)V"),
                                    static_cast<jboolean>(open));
                env->DeleteLocalRef(cls);
                if (env->ExceptionCheck()) {
                    env->ExceptionClear();
                    LOG("Native settings callback failed");
                }
            }
            // Slider release/presets select new world targets once they settle, only with no
            // image acquired (WorldRenderer::updateTargets).
            renderer->updateTargets(controls.graphics, nowMs,
                                    focused && poseValid && frame.shouldRender);
            // Only the local render snapshot is smoothed. Native tracked poses remain
            // current, and gameplay, collision, picking and server state are unchanged.
            presentation.present(
                controls,
                std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count(),
                focused && poseValid && frame.shouldRender);
            // settingsOpen before the handoff: nativeCloseSettings writes them in the other order,
            // so no frame sees the settings closed without the handoff that keeps the quad up.
            const bool settingsShown = settingsOpen.load();
            const bool handoff = settingsHandoff.exchange(false);
            controls.panelOpen =
                workspacePanel.step(controls.panelOpen, overlayOpen, settingsShown, handoff, nowMs);
            bool showStatus = controls.active && !controls.panelOpen && controls.statusVisible &&
                              frame.shouldRender && poseValid;
            if (controls.status != previousStatus || showStatus != previousStatusVisible) {
                previousStatus = controls.status;
                previousStatusVisible = showStatus;
                jclass cls = env->GetObjectClass(activity);
                jstring text = env->NewStringUTF(controls.status.c_str());
                env->CallVoidMethod(activity,
                                    env->GetMethodID(cls, "onStatus", "(Ljava/lang/String;Z)V"),
                                    text, static_cast<jboolean>(showStatus));
                env->DeleteLocalRef(text);
                env->DeleteLocalRef(cls);
            }
            for (const auto &pulse : controls.haptics)
                input->haptic(pulse.hand, pulse.strength, pulse.ms);
            if (controls.panelOpen && !previousPanelOpen)
                panelPlaced = false;
            previousPanelOpen = controls.panelOpen;
            scrollTime += frame.predictedDisplayPeriod / 1e9;
            if (!panelPlaced && frame.shouldRender && poseValid) {
                auto forward = office::rotate(head.orientation, {0, 0, -1});
                float angle = std::atan2(-forward.x, -forward.z);
                panelPose.orientation = office::yaw(angle);
                panelPose.position = office::add(
                    head.position, office::rotate(panelPose.orientation, {0, -.1f, -1.5f}));
                panelPlaced = true;
            }
            std::array<office::PanelHover::Sample, 2> hoverSamples{};
            for (int h = 0; h < 2; h++) {
                auto &hand = inputFrame.hands[h];
                float x = 0, y = 0, distance = 0;
                bool hit = controls.panelOpen && hand.active && !controls.hands[h].holding &&
                           office::panelHit(hand.aim, panelPose, 1.8f, 1.2f, x, y, distance);
                cursorVisible[h] = hit;
                hoverSamples[h] = {hit, x * 2400, y * 1600};
                if (hit)
                    cursorPose[h] = office::compose(
                        panelPose, {{0, 0, 0, 1}, {(x - .5f) * 1.8f, (.5f - y) * 1.2f, .004f}});
                auto touch =
                    pointer.step(h, {hand.active, controls.panelOpen, controls.hands[h].holding,
                                     hit, hand.trigger, x * 2400, y * 1600});
                hand.ui = touch.consumed;
                if (touch.action == 0)
                    input->haptic(h);
                if (touch.action >= 0) {
                    jclass cls = env->GetObjectClass(activity);
                    auto callback = env->GetMethodID(cls, "onPointer", "(IFF)V");
                    env->CallVoidMethod(activity, callback, touch.action, touch.x, touch.y);
                    env->DeleteLocalRef(cls);
                }
                if (hit && scrollTime >= .05f &&
                    (std::abs(hand.stick.x) > .2f || std::abs(hand.stick.y) > .2f)) {
                    jclass cls = env->GetObjectClass(activity);
                    env->CallVoidMethod(activity, env->GetMethodID(cls, "onScroll", "(FFFF)V"),
                                        touch.x, touch.y, hand.stick.x * .5f, hand.stick.y * .5f);
                    env->DeleteLocalRef(cls);
                }
            }
            const auto mouse =
                hover.step(hoverSamples, pointer.pressed(), frame.predictedDisplayTime / 1e9);
            if (mouse.action >= 0) {
                jclass cls = env->GetObjectClass(activity);
                env->CallVoidMethod(activity, env->GetMethodID(cls, "onPointer", "(IFF)V"),
                                    mouse.action, mouse.x, mouse.y);
                env->DeleteLocalRef(cls);
            }
            if (scrollTime >= .05f)
                scrollTime = 0;
            {
                std::lock_guard<std::mutex> lock(inputMutex);
                if (inputFrames.size() >= 90)
                    inputFrames.erase(inputFrames.begin());
                inputFrames.push_back(inputFrame);
                // The native settings own the left Menu button; the drawn controller still
                // animates it from inputFrame.
                inputFrames.back().hands[0].menu = false;
            }
            // XR_EXT_eye_gaze_interaction: an interaction pose that only feeds the metrics. World
            // foveation is fixed and never follows it (foveation.h).
            XrPosef gazePose;
            bool gazeValid = input->gazePose(space, frame.predictedDisplayTime, gazePose);
            std::array<XrCompositionLayerProjectionView, 2> projectionViews, sharpProjectionViews;
            auto projection = office::structure<XrCompositionLayerProjection>(
                XR_TYPE_COMPOSITION_LAYER_PROJECTION);
            projection.space = space;
            projection.viewCount = 2;
            projection.views = projectionViews.data();
            auto sharpProjection = office::structure<XrCompositionLayerProjection>(
                XR_TYPE_COMPOSITION_LAYER_PROJECTION);
            sharpProjection.space = space;
            sharpProjection.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
            sharpProjection.viewCount = 2;
            sharpProjection.views = sharpProjectionViews.data();
            bool valid = frame.shouldRender && poseValid;
            office::WorldFrame world;
            world.views = &views;
            world.input = &inputFrame;
            world.controls = &controls;
            world.panelPose = panelPose;
            world.focused = focused;
            world.poseValid = poseValid;
            world.shouldRender = frame.shouldRender;
            world.valid = valid;
            // The workspace panel goes beneath the world layer, which then shows it through a
            // hole the renderer cuts (panel_cutout.h) and keeps the player's controllers, rays
            // and held gun in front of it.
            const bool panelUnder = valid && controls.panelOpen;
            world.panelUnder = panelUnder;
            const bool sharp = renderer->render(world, projectionViews, sharpProjectionViews);
            // The status card is a quad over the world: it yields to what the player holds up in
            // front of it, the drawn controllers and the bounds of the gun in hand. A held gun
            // takes the controller's place in the hand (WorldRenderer::attachedHands).
            bool statusCovered = false;
            if (colorScaleBias && valid && statusProducerVisible) {
                const unsigned heldHands = renderer->attachedHands();
                std::array<office::HandBall, 2 + 32> balls;
                size_t count = office::controllerBalls(inputFrame, heldHands, balls.data());
                float bounds[32][4];
                const size_t held = renderer->attachedBounds(bounds, 32);
                const auto fromWorld = office::inverseRigid(controls.rig);
                for (size_t i = 0; i < held; i++)
                    balls[count++] = {office::transformPoint(
                                          fromWorld, {bounds[i][0], bounds[i][1], bounds[i][2]}),
                                      bounds[i][3]};
                // The toast card's quad (status_layout.h), as composited below.
                const office::StatusQuad toastQuad{office::status::kMessagePose.position,
                                                   office::status::kMessageSize.width,
                                                   office::status::kMessageSize.height};
                statusCovered = office::handsCoverStatus(head, balls.data(), count, toastQuad);
            }
            const float statusOpacity =
                statusYield.step(statusCovered, frame.predictedDisplayPeriod / 1e9f);
            auto panel = office::structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
            panel.space = space;
            panel.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
            panel.pose = panelPose;
            panel.size = {office::kPanelWidth, office::kPanelHeight};
            panel.subImage.swapchain = panelSwapchain;
            panel.subImage.imageRect.extent = {2400, 1600};
            // Both status quads show columns of the one status Surface (status_layout.h).
            auto statusMessage =
                office::structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
            statusMessage.space = viewSpace;
            statusMessage.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
            statusMessage.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
            statusMessage.pose = office::status::kMessagePose;
            statusMessage.size = office::status::kMessageSize;
            statusMessage.subImage.swapchain = statusSwapchain;
            statusMessage.subImage.imageRect = {
                {0, 0}, {office::status::kMessageWidth, office::status::kHeight}};
            auto statusCounter = statusMessage;
            statusCounter.pose = office::status::counterPose();
            statusCounter.size = office::status::kCounterSize;
            statusCounter.subImage.imageRect = {
                {office::status::kCounterLeft, 0},
                {office::status::kCounterWidth, office::status::kHeight}};
            const bool counterClear =
                counterReveal.visible(office::status::counterCovered(head, inputFrame.hands),
                                      frame.predictedDisplayTime / 1e9);
            const auto statusLayers = office::status::layers(
                statusProducerVisible, controls.panelOpen, controls.statusCounter,
                controls.statusMessage, counterClear);
            // The toast card yields to a hand or held gun in front of it (layer_occlusion.h); the
            // counter has its own cover test above and simply hides.
            auto statusFade = office::structure<XrCompositionLayerColorScaleBiasKHR>(
                XR_TYPE_COMPOSITION_LAYER_COLOR_SCALE_BIAS_KHR);
            if (colorScaleBias && statusOpacity < 1) {
                // Premultiplied: color and alpha scale together. Still submitted at 0, so the
                // Surface producer's frames keep being consumed.
                statusFade.colorScale = {statusOpacity, statusOpacity, statusOpacity,
                                         statusOpacity};
                statusFade.colorBias = {0, 0, 0, 0};
                statusMessage.next = &statusFade;
            }
            std::vector<const XrCompositionLayerBaseHeader *> layers;
            if (valid) {
                // Beneath the world layer, which shows the panel and its pointers through the
                // hole PanelCutout punched, with the hands in front of it.
                if (panelUnder) {
                    layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&panel));
                    projection.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
                }
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&projection));
                if (sharp)
                    layers.push_back(
                        reinterpret_cast<XrCompositionLayerBaseHeader *>(&sharpProjection));
            }
            // VIEW-space status does not depend on valid application eye poses. Drain a pending
            // Canvas post even when the world is temporarily invalid or shouldRender is false,
            // until the UI-thread producer shutdown acknowledgment arrives.
            if (statusLayers.message)
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&statusMessage));
            if (statusLayers.counter)
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&statusCounter));
            auto end = office::structure<XrFrameEndInfo>(XR_TYPE_FRAME_END_INFO);
            end.displayTime = frame.predictedDisplayTime;
            end.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
            end.layerCount = layers.size();
            end.layers = layers.data();
            check(xrEndFrame(session, &end), "end frame");
            double cpuMs =
                std::chrono::duration<double, std::milli>(Clock::now() - cpuStarted).count();
            metrics.submit(valid, state == XR_SESSION_STATE_FOCUSED, frame.predictedDisplayTime,
                           frame.predictedDisplayPeriod, cpuMs);
            if (metrics.ready()) {
                float refresh = 0;
                if (getRate && XR_SUCCEEDED(getRate(session, &refresh)))
                    observedRefreshRate = refresh;
                auto frameMetrics = nlohmann::json::parse(
                    metrics.json(refresh, frame.predictedDisplayPeriod / 1e6, gazeValid));
                controlHeartbeatMetrics(frameMetrics);
                frameMetrics["refreshRequestedHz"] = 90;
                frameMetrics["refreshRequests"] = refreshRequests;
                frameMetrics["sharpSetting"] = controls.graphics.sharpScreens;
                // The world targets, the bound foveation and this frame's screen layer.
                renderer->addFrameMetrics(frameMetrics);
                const auto fovea = renderer->foveationMetrics(controls.graphics);
                const auto suffix = renderer->frameMetricsSuffix();
                // One log record each (log_record.h); the pulled metrics keep every value whole.
                const auto report = office::fitLogJson(
                    frameMetrics,
                    office::logJsonBudget(std::strlen("FRAME_METRICS ") + suffix.size()));
                auto counters = performance->sampleJson();
                auto runtime = nlohmann::json::parse(counters);
                auto combined = std::move(frameMetrics);
                combined["foveation"] = fovea;
                combined["runtime"] = runtime;
                auto stats = renderer->sceneStats();
                nlohmann::json sceneMetrics = {{"objects", stats.objects},
                                               {"visible", stats.visibleObjects},
                                               {"drawCalls", stats.drawCalls},
                                               {"sharpScreens", stats.sharpScreens},
                                               {"sharpItems", stats.sharpItems},
                                               {"attachedItems", stats.attachedItems},
                                               {"attachedPlaced", stats.attachedPlaced},
                                               {"sharpOverlays", stats.sharpOverlays},
                                               {"sharpDrawCalls", stats.sharpDrawCalls},
                                               {"sharpMs", stats.sharpMs},
                                               {"sharpViewPixels", stats.sharpViewPixels},
                                               {"sharpRegionPixels", stats.sharpRegionPixels},
                                               {"shadowDrawCalls", stats.shadowDrawCalls},
                                               {"shadowMapDraws", stats.shadowMapDraws},
                                               {"shadowRedraws", stats.shadowRedraws},
                                               {"triangles", stats.triangles},
                                               {"staticBatches", stats.staticBatches},
                                               {"batchedObjects", stats.batchedObjects},
                                               {"dynamicObjects", stats.dynamicObjects},
                                               {"textures", stats.textures},
                                               {"programs", stats.programs},
                                               {"pendingUploads", stats.pendingUploads},
                                               {"waitingState", stats.waitingState},
                                               {"queuedTextureOps", stats.queuedTextureOps},
                                               {"uploadedBytes", stats.uploadedBytesLastFrame},
                                               {"queuedBytes", stats.queuedBytes},
                                               {"packetsApplied", stats.packetsApplied},
                                               {"packetsRejected", stats.packetsRejected},
                                               {"unsupported", stats.unsupported},
                                               {"cpuMs", stats.cpuMs},
                                               {"prepareMs", stats.prepareMs},
                                               {"drawMs", stats.drawMs},
                                               {"cpuMaxMs", stats.cpuMaxMs},
                                               {"parseMs", stats.parseMs},
                                               {"applyMaxMs", stats.applyMaxMs},
                                               {"programsCompiling", stats.programsCompiling},
                                               {"programsFailed", stats.programsFailed},
                                               {"vertexArrays", stats.vertexArrays},
                                               {"gpuMs", stats.gpuMs},
                                               {"applyMs", stats.applyMs},
                                               {"seq", stats.sceneSeq},
                                               {"stateSerial", stats.stateSerial}};
                combined["scene"] = sceneMetrics;
                std::string published = combined.dump(-1, ' ', true);
                // The closed-workspace counter comes from the host, with the page's toast.
                nlohmann::json counter = {{"fps", combined["fps"]},
                                          {"refresh", combined["refresh"]},
                                          {"focused", combined["focused"]},
                                          {"controlAgeMs", combined["controlAgeMs"]}};
                bridge.setCounter(office::fpsCounterText(counter.dump()));
                {
                    std::lock_guard<std::mutex> lock(metricsMutex);
                    latestMetrics = std::move(published);
                }
                LOG("FRAME_METRICS %s%s", report.c_str(), suffix.c_str());
                LOG("FOVEATION_METRICS %s",
                    office::fitLogJson(fovea,
                                       office::logJsonBudget(std::strlen("FOVEATION_METRICS ")))
                        .c_str());
                // Some Android log routes truncate long records. Keep every counter in
                // the pulled metrics and log the critical display/GPU counters together.
                nlohmann::json displayMetrics = nlohmann::json::object();
                for (const char *name : {"/perfmetrics_android/app/cpu_frametime",
                                         "/perfmetrics_android/app/gpu_frametime",
                                         "/perfmetrics_android/app/motion_to_photon_latency",
                                         "/perfmetrics_android/compositor/frames_per_second",
                                         "/perfmetrics_android/compositor/dropped_frame_count",
                                         "/perfmetrics_android/compositor/gpu_frametime",
                                         "/perfmetrics_android/device/gpu_utilization"}) {
                    if (runtime.contains(name))
                        displayMetrics[name] = runtime[name];
                }
                LOG("RUNTIME_METRICS %s",
                    office::fitLogJson(displayMetrics,
                                       office::logJsonBudget(std::strlen("RUNTIME_METRICS ")))
                        .c_str());
                LOG("SCENE_METRICS %s",
                    office::fitLogJson(sceneMetrics,
                                       office::logJsonBudget(std::strlen("SCENE_METRICS ")))
                        .c_str());
                metrics.reset();
            }
        }
    }
};
} // namespace

extern "C" JNIEXPORT void JNICALL Java_dev_droidoffice_xr_OfficeActivity_nativeStart(
    JNIEnv *env, jobject activity, jstring filesDirectory) {
    if (renderThread.joinable())
        return;
    if (filesDirectory) {
        const char *path = env->GetStringUTFChars(filesDirectory, nullptr);
        if (path) {
            std::lock_guard<std::mutex> lock(graphicsStoreMutex);
            graphicsStorePath = std::string(path) + "/native-graphics.json";
            env->ReleaseStringUTFChars(filesDirectory, path);
        }
    }
    env->GetJavaVM(&vm);
    jobject global = env->NewGlobalRef(activity);
    // This APK's own settings view owns graphics (HOST_FLAGS nativeSettings): pages only mirror
    // them from nativeReadEvents, and their control packets' graphics are ignored.
    bridge.ownGraphics();
    stopping = false;
    focused = false;
    rebaseRequested = false;
    overlayOpen = false;
    settingsOpen = false;
    settingsHandoff = false;
    statusProducerVisible = false;
    resetControlHeartbeat();
    observedRefreshRate = 0;
    {
        std::lock_guard<std::mutex> lock(metricsMutex);
        latestMetrics = "{}";
    }
    std::string renderer;
    renderer.swap(rendererOptions);
    renderThread = std::thread([global, renderer] {
        (void)renderer; // Empty, and unused, unless the build has the Vulkan spike.
        JNIEnv *threadEnv = nullptr;
        vm->AttachCurrentThread(&threadEnv, nullptr);
        jclass process = threadEnv->FindClass("android/os/Process");
        threadEnv->CallStaticVoidMethod(
            process, threadEnv->GetStaticMethodID(process, "setThreadPriority", "(I)V"), -4);
        threadEnv->DeleteLocalRef(process);
        if (threadEnv->ExceptionCheck()) {
            threadEnv->ExceptionClear();
            LOG("Display thread priority could not be set");
        }
        std::string ended = "The headset session ended";
        {
            office::GraphicsControls stored;
            const bool restored = readStoredGraphics(stored);
            if (restored)
                bridge.seedGraphics(stored);
            LOG("GRAPHICS_STORED restored=%d", restored);
        }
        try {
#ifdef OFFICE_VULKAN_SPIKE
            if (!renderer.empty()) {
                office::spike::Host host;
                host.vm = vm;
                host.env = threadEnv;
                host.activity = global;
                host.options = renderer;
                host.stopping = &stopping;
                host.focused = &focused;
                host.statusProducerVisible = &statusProducerVisible;
                host.observedRefreshRate = &observedRefreshRate;
                host.publishMetrics = [](const std::string &json) {
                    std::lock_guard<std::mutex> lock(metricsMutex);
                    latestMetrics = json;
                };
                office::spike::run(host);
            } else
#endif
            {
                Office office(threadEnv, global);
                office.init();
                office.loop();
            }
        } catch (const std::exception &error) {
            LOG("ERROR %s", error.what());
            ended = error.what();
        }
        if (!stopping) {
            jclass cls = threadEnv->GetObjectClass(global);
            jmethodID callback =
                threadEnv->GetMethodID(cls, "onNativeEnded", "(Ljava/lang/String;)V");
            jstring message = threadEnv->NewStringUTF(ended.c_str());
            threadEnv->CallVoidMethod(global, callback, message);
            threadEnv->DeleteLocalRef(message);
            threadEnv->DeleteLocalRef(cls);
        }
        threadEnv->DeleteGlobalRef(global);
        vm->DetachCurrentThread();
    });
}

// OfficeActivity calls this only in debug builds with `--es xr_renderer vulkan-spike`.
extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeSelectRenderer(JNIEnv *env, jobject, jstring options) {
    std::string value;
    if (const char *text = options ? env->GetStringUTFChars(options, nullptr) : nullptr) {
        value = text;
        env->ReleaseStringUTFChars(options, text);
    }
#ifdef OFFICE_VULKAN_SPIKE
    LOG("XR_RENDERER %s", value.c_str());
    if (!renderThread.joinable())
        rendererOptions = value;
#else
    LOG("XR_RENDERER ignored (this build has no Vulkan spike): %s", value.c_str());
#endif
}

extern "C" JNIEXPORT void JNICALL Java_dev_droidoffice_xr_OfficeActivity_nativeStop(JNIEnv *,
                                                                                    jobject) {
    stopping = true;
    if (renderThread.joinable())
        renderThread.join();
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeReadInput(JNIEnv *env, jobject) {
    std::vector<office::InputFrame> frames;
    {
        std::lock_guard<std::mutex> lock(inputMutex);
        frames.swap(inputFrames);
    }
    auto json = office::XrInput::json(frames);
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeReadMetrics(JNIEnv *env, jobject) {
    const auto report = currentMetrics();
    return env->NewStringUTF(report.c_str());
}

// ---- The APK's settings view (NativeSettingsView.java), UI thread ----------------------------

extern "C" JNIEXPORT jstring JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeReadGraphicsStatus(JNIEnv *env, jobject) {
    const auto status = office::graphicsStatus(bridge.graphics(), currentMetrics());
    return env->NewStringUTF(status.c_str());
}

/** Applies at once; the renderer replaces targets once the choice has been stable for 250 ms. */
extern "C" JNIEXPORT jboolean JNICALL Java_dev_droidoffice_xr_OfficeActivity_nativeSetGraphics(
    JNIEnv *env, jobject, jfloat renderScale, jstring foveation, jboolean fps) {
    auto graphics = bridge.graphics();
    std::string name;
    if (const char *text = foveation ? env->GetStringUTFChars(foveation, nullptr) : nullptr) {
        name = text;
        env->ReleaseStringUTFChars(foveation, text);
    }
    if (!std::isfinite(renderScale) || !office::foveationFromName(name, graphics.foveation))
        return JNI_FALSE;
    graphics.renderScale = renderScale;
    graphics.fps = fps;
    if (!bridge.setGraphics(graphics))
        return JNI_FALSE;
    const auto applied = bridge.graphics();
    LOG("NATIVE_GRAPHICS renderScale=%.3f foveation=%s fps=%d", applied.renderScale,
        office::foveationQualityName(applied.foveation), applied.fps);
    return JNI_TRUE;
}

/** Writes a changed choice to files/native-graphics.json. The bridge worker calls it. */
extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativePersistGraphics(JNIEnv *, jobject) {
    persistGraphics();
}

extern "C" JNIEXPORT jboolean JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeSettingsOpen(JNIEnv *, jobject) {
    return settingsOpen.load();
}

/** The view's own Close or Office workspace button. workspace: hold the quad for the page. */
extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeCloseSettings(JNIEnv *, jobject, jboolean workspace) {
    if (!settingsOpen.load())
        return;
    if (workspace)
        settingsHandoff = true;
    settingsOpen = false;
    LOG("NATIVE_SETTINGS open=0 source=%s", workspace ? "workspace" : "close");
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeReadEvents(JNIEnv *env, jobject) {
    bool sceneReady, sceneReset = false;
    {
        std::lock_guard<std::mutex> lock(sceneConsumerMutex);
        sceneReady = sceneConsumer && (!sceneAccepts || sceneAccepts());
        if (sceneResetNeeded)
            sceneReset = sceneResetNeeded();
    }
    // graphics and nativeSettingsOpen are read-only mirrors of the host's settings view.
    const std::string events =
        std::string("{\"resetInput\":") + (focused ? "false" : "true") +
        ",\"recenter\":" + (rebaseRequested.exchange(false) ? "true" : "false") +
        ",\"sceneReady\":" + (sceneReady ? "true" : "false") +
        ",\"sceneReset\":" + (sceneReset ? "true" : "false") +
        ",\"graphics\":" + office::graphicsEvent(bridge.graphics()) +
        ",\"nativeSettingsOpen\":" + (settingsOpen ? "true" : "false") +
        (puppetEnabled ? ",\"puppet\":true}" : "}");
    return env->NewStringUTF(events.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeCapturePuppet(JNIEnv *, jobject, jboolean hostDebug) {
    const bool enabled = office::capturePuppetEnabled(hostDebug);
    puppetEnabled = enabled;
    bridge.allowPuppet(enabled);
    LOG("CAPTURE_PUPPET build=%d host=%d enabled=%d", office::kCapturePuppetBuild,
        static_cast<int>(hostDebug), enabled);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeOverlay(JNIEnv *, jobject, jboolean visible) {
    overlayOpen = visible;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeStatusVisible(JNIEnv *, jobject, jboolean visible) {
    statusProducerVisible = visible;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeSubmit(JNIEnv *env, jobject, jbyteArray packet) {
    if (!packet || env->GetArrayLength(packet) > 4 * 1024 * 1024)
        return;
    const auto received =
        std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch())
            .count();
    std::string value(static_cast<size_t>(env->GetArrayLength(packet)), '\0');
    env->GetByteArrayRegion(packet, 0, value.size(), reinterpret_cast<jbyte *>(value.data()));
    if (env->ExceptionCheck())
        return;
    std::string scene, error;
    bool validControl = bridge.submit(value, scene, error);
    if (validControl) {
        lastControlReceiptNs = received;
        ++controlHeartbeats;
    }
    persistGraphics();
    if (!error.empty())
        LOG("BRIDGE_ERROR %s", error.c_str());
    if (!scene.empty() || validControl) {
        std::lock_guard<std::mutex> lock(sceneConsumerMutex);
        if (sceneConsumer)
            sceneConsumer(scene.empty() ? "{\"scene\":null}" : scene);
        else if (scenePendingBytes + scene.size() <= 8 * 1024 * 1024) {
            scenePendingBytes += scene.size();
            scenePending.push_back(std::move(scene));
        } else
            LOG("BRIDGE_ERROR Scene producer exceeded startup queue");
    }
}

extern "C" JNIEXPORT void JNICALL Java_dev_droidoffice_xr_OfficeActivity_nativeReset(JNIEnv *,
                                                                                     jobject) {
    resetControlHeartbeat();
    bridge.reset();
    {
        std::lock_guard<std::mutex> lock(inputMutex);
        inputFrames.clear();
    }
    std::lock_guard<std::mutex> lock(sceneConsumerMutex);
    scenePending.clear();
    scenePendingBytes = 0;
    if (sceneConsumer)
        sceneConsumer("{\"v\":1,\"seq\":1,\"reset\":true,\"commit\":true}");
}
