#include "bridge_state.h"
#include "cursor_swapchain.h"
#ifndef NDEBUG
#include "depth_probe.h"
#endif
#include "frame_metrics.h"
#include "input_renderer.h"
#include "json.hpp"
#include "panel_pointer.h"
#include "refresh_policy.h"
#include "rig_presentation.h"
#include "scene_renderer.h"
#include "xr_input.h"
#include "xr_math.h"
#include "xr_performance.h"
#include "xr_util.h"
#include <EGL/egl.h>
#include <GLES2/gl2ext.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <deque>
#include <functional>
#include <jni.h>
#include <memory>
#include <mutex>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
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

void check(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}

template <class T> T function(XrInstance instance, const char *name) {
    PFN_xrVoidFunction value = nullptr;
    check(xrGetInstanceProcAddr(instance, name, &value), name);
    return reinterpret_cast<T>(value);
}

struct Eye {
    XrSwapchain swapchain = XR_NULL_HANDLE;
    int width = 0, height = 0;
    std::vector<XrSwapchainImageOpenGLESKHR> images;
    std::vector<float> foveationDensity;
};

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
    XrPosef panelPose{{0, 0, 0, 1}, {0, 0, -1.5f}};
    bool panelPlaced = false;
    bool previousPanelOpen = true;
    office::PanelPointer pointer;
    std::array<XrPosef, 2> cursorPose{};
    std::array<bool, 2> cursorVisible{};
    float scrollTime = 0;
    XrSessionState state = XR_SESSION_STATE_UNKNOWN;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    GLuint framebuffer = 0, depthTexture = 0, sharpFramebuffer = 0;
    bool multiview = false;
    int samples = 4;
    PFNGLFRAMEBUFFERTEXTUREMULTIVIEWOVRPROC attachMultiview = nullptr;
    PFNGLFRAMEBUFFERTEXTUREMULTISAMPLEMULTIVIEWOVRPROC attachMultisampleMultiview = nullptr;
    bool running = false;
    XrTime spaceChangeTime = 0;
    std::array<Eye, 2> eyes, sharpEyes;
    std::array<office::ResolutionLimits, 2> worldLimits;
    office::RenderTargetChanges targetChanges;
    int64_t worldFormat = GL_RGBA8;
    bool swapchainFoveation = false, worldFoveated = false;
    std::string graphicsError;
    bool sharpScreensAvailable = false;
#ifndef NDEBUG
    std::unique_ptr<office::DepthProbe> depthProbe;
#endif
    PFN_xrGetDisplayRefreshRateFB getRate = nullptr;
    PFN_xrRequestDisplayRefreshRateFB requestRate = nullptr;
    office::RefreshPolicy refreshPolicy;
    double lastRateCheckMs = -1000;
    uint32_t refreshRequests = 0;
    std::unique_ptr<office::XrInput> input;
    std::unique_ptr<office::InputRenderer> inputRenderer;
    std::unique_ptr<office::CursorSwapchain> cursor;
    std::unique_ptr<office::RuntimePerformance> performance;
    std::unique_ptr<office::SceneRenderer> sceneRenderer;
    PFNGLTEXTUREFOVEATIONPARAMETERSQCOMPROC textureFoveation = nullptr;
    int focalPoints = 1;

    Office(JNIEnv *e, jobject a) : env(e), activity(a) {}

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
        // including the cursor. The last frame's glFlush only submitted those commands.
        if (context != EGL_NO_CONTEXT)
            glFinish();
        inputRenderer.reset();
        sceneRenderer.reset();
#ifndef NDEBUG
        depthProbe.reset();
#endif
        cursor.reset();
        input.reset();
        performance.reset();
        if (panelSwapchain)
            xrDestroySwapchain(panelSwapchain);
        if (statusSwapchain)
            xrDestroySwapchain(statusSwapchain);
        for (auto &eye : eyes)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        for (auto &eye : sharpEyes)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        if (sharpFramebuffer)
            glDeleteFramebuffers(1, &sharpFramebuffer);
        if (framebuffer)
            glDeleteFramebuffers(1, &framebuffer);
        if (depthTexture)
            glDeleteTextures(1, &depthTexture);
        if (space)
            xrDestroySpace(space);
        if (viewSpace)
            xrDestroySpace(viewSpace);
        if (session)
            xrDestroySession(session);
        if (instance)
            xrDestroyInstance(instance);
        if (display != EGL_NO_DISPLAY) {
            eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (surface != EGL_NO_SURFACE)
                eglDestroySurface(display, surface);
            if (context != EGL_NO_CONTEXT)
                eglDestroyContext(display, context);
            eglTerminate(display);
        }
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

    office::RenderTargetRequest worldTargetRequest(float scale, bool foveated) const {
        office::RenderTargetRequest request;
        request.foveated = foveated && textureFoveation;
        for (int i = 0; i < (multiview ? 1 : 2); ++i)
            request.size[i] = office::renderSize(worldLimits[i], scale);
        return request;
    }

    void attachWorldImage(const Eye &eye, uint32_t imageIndex, GLuint depth) {
        const auto image = eye.images[imageIndex].image;
        if (multiview && samples > 1) {
            attachMultisampleMultiview(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, image, 0, samples, 0,
                                       2);
            attachMultisampleMultiview(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, depth, 0, samples, 0,
                                       2);
        } else if (multiview) {
            attachMultiview(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, image, 0, 0, 2);
            attachMultiview(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, depth, 0, 0, 2);
        } else {
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, image, 0);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth, 0);
        }
    }

    /** Called only on the GL thread with no acquired world images. Keep old targets on failure. */
    bool replaceWorldTargets(const office::RenderTargetRequest &request) {
        std::array<Eye, 2> next;
        GLuint nextDepth = 0, nextFramebuffer = 0;
        XrSwapchain acquired = XR_NULL_HANDLE;
        bool waited = false;
        int nextFocalPoints = focalPoints;
        try {
            glActiveTexture(GL_TEXTURE0);
            for (int i = 0; i < (multiview ? 1 : 2); ++i) {
                auto &eye = next[i];
                eye.width = request.size[i].width;
                eye.height = request.size[i].height;
                auto sc = office::structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
                auto foveated = office::structure<XrSwapchainCreateInfoFoveationFB>(
                    XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB);
                foveated.flags = XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB;
                sc.next = request.foveated && swapchainFoveation ? &foveated : nullptr;
                sc.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
                sc.format = worldFormat;
                sc.sampleCount = 1;
                sc.width = eye.width;
                sc.height = eye.height;
                sc.faceCount = 1;
                sc.arraySize = multiview ? 2 : 1;
                sc.mipCount = 1;
                check(xrCreateSwapchain(session, &sc, &eye.swapchain), "create world swapchain");
                uint32_t count = 0;
                check(xrEnumerateSwapchainImages(eye.swapchain, 0, &count, nullptr),
                      "world image count");
                eye.images.resize(count, office::structure<XrSwapchainImageOpenGLESKHR>(
                                             XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR));
                eye.foveationDensity.assign(count, .25f);
                check(xrEnumerateSwapchainImages(
                          eye.swapchain, count, &count,
                          reinterpret_cast<XrSwapchainImageBaseHeader *>(eye.images.data())),
                      "world images");
                if (request.foveated)
                    for (auto image : eye.images) {
                        const GLenum target = multiview ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
                        glBindTexture(target, image.image);
                        GLint features = 0;
                        glGetTexParameteriv(target, GL_TEXTURE_FOVEATED_FEATURE_QUERY_QCOM,
                                            &features);
                        constexpr auto bits =
                            GL_FOVEATION_ENABLE_BIT_QCOM | GL_FOVEATION_SCALED_BIN_METHOD_BIT_QCOM;
                        if ((features & bits) != bits)
                            throw std::runtime_error(
                                "World texture cannot use scaled-bin foveation");
                        glGetTexParameteriv(target, GL_TEXTURE_FOVEATED_NUM_FOCAL_POINTS_QUERY_QCOM,
                                            &nextFocalPoints);
                        if (nextFocalPoints < 1 || nextFocalPoints > 16)
                            throw std::runtime_error("Invalid foveation focal point count");
                        glTexParameteri(target, GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM, bits);
                        glTexParameterf(target, GL_TEXTURE_FOVEATED_MIN_PIXEL_DENSITY_QCOM, .25f);
                    }
            }
            glGenTextures(1, &nextDepth);
            const GLenum depthTarget = multiview ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
            glBindTexture(depthTarget, nextDepth);
            if (multiview)
                glTexStorage3D(depthTarget, 1, GL_DEPTH_COMPONENT24, next[0].width, next[0].height,
                               2);
            else
                glTexStorage2D(depthTarget, 1, GL_DEPTH_COMPONENT24,
                               std::max(next[0].width, next[1].width),
                               std::max(next[0].height, next[1].height));
            glTexParameteri(depthTarget, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(depthTarget, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            glTexParameteri(depthTarget, GL_TEXTURE_COMPARE_MODE, GL_NONE);
            glTexParameteri(depthTarget, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(depthTarget, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            const auto error = glGetError();
            if (error != GL_NO_ERROR)
                throw std::runtime_error("World target allocation GL error " +
                                         std::to_string(error));
            // Tile MSAA storage is allocated by framebuffer attachment, beyond the textures.
            // Exercise the exact render attachment path before replacing the existing targets.
            glGenFramebuffers(1, &nextFramebuffer);
            for (int i = 0; i < (multiview ? 1 : 2); ++i) {
                const auto &eye = next[i];
                uint32_t imageIndex = 0;
                auto acquire = office::structure<XrSwapchainImageAcquireInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
                check(xrAcquireSwapchainImage(eye.swapchain, &acquire, &imageIndex),
                      "acquire staged world image");
                acquired = eye.swapchain;
                auto wait =
                    office::structure<XrSwapchainImageWaitInfo>(XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
                wait.timeout = 100'000'000;
                const auto ready = xrWaitSwapchainImage(acquired, &wait);
                if (ready == XR_TIMEOUT_EXPIRED)
                    throw std::runtime_error("World target validation timed out");
                check(ready, "wait staged world image");
                waited = true;
                glBindFramebuffer(GL_FRAMEBUFFER, nextFramebuffer);
                attachWorldImage(eye, imageIndex, nextDepth);
                const auto status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
                if (status != GL_FRAMEBUFFER_COMPLETE)
                    throw std::runtime_error("World target framebuffer incomplete: " +
                                             std::to_string(status));
                glDisable(GL_SCISSOR_TEST);
                glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
                glDepthMask(GL_TRUE);
                glClearColor(0, 0, 0, 1);
                glClearDepthf(1);
                glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                glFinish();
                const auto validationError = glGetError();
                if (validationError != GL_NO_ERROR)
                    throw std::runtime_error("World target validation GL error " +
                                             std::to_string(validationError));
                auto release = office::structure<XrSwapchainImageReleaseInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                check(xrReleaseSwapchainImage(acquired, &release), "release staged world image");
                acquired = XR_NULL_HANDLE;
                waited = false;
            }
        } catch (const std::exception &error) {
            graphicsError = error.what();
            LOG("WORLD_TARGET_REJECTED %s", graphicsError.c_str());
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            glFinish();
            if (nextFramebuffer)
                glDeleteFramebuffers(1, &nextFramebuffer);
            if (acquired && waited) {
                auto release = office::structure<XrSwapchainImageReleaseInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                xrReleaseSwapchainImage(acquired, &release);
            }
            if (nextDepth)
                glDeleteTextures(1, &nextDepth);
            for (auto &eye : next)
                if (eye.swapchain)
                    xrDestroySwapchain(eye.swapchain);
            return false;
        }
        // Validation completed prior GPU image use and released every staged image.
        // Keep the validated framebuffer; no synchronization is added to the display loop.
        std::swap(eyes, next);
        std::swap(depthTexture, nextDepth);
        std::swap(framebuffer, nextFramebuffer);
        if (nextFramebuffer)
            glDeleteFramebuffers(1, &nextFramebuffer);
        if (nextDepth)
            glDeleteTextures(1, &nextDepth);
        for (auto &eye : next)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        worldFoveated = request.foveated;
        focalPoints = nextFocalPoints;
        graphicsError.clear();
        LOG("WORLD_TARGET size=%dx%d foveated=%d", eyes[0].width, eyes[0].height, worldFoveated);
        return true;
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
                                             XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME};
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
        const bool foveation = supports(XR_FB_FOVEATION_EXTENSION_NAME) &&
                               supports(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME);
        if (foveation) {
            extensions.push_back(XR_FB_FOVEATION_EXTENSION_NAME);
            extensions.push_back(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME);
        }
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
        check(xrGetSystemProperties(instance, system, &systemProperties), "system properties");
        // World + sharp screens + workspace + two pointers + the status shutdown handshake.
        sharpScreensAvailable = systemProperties.graphicsProperties.maxLayerCount >= 6;
        LOG("LAYER_CAPACITY max=%u sharpScreens=%d",
            systemProperties.graphicsProperties.maxLayerCount, sharpScreensAvailable);
        auto requirements = office::structure<XrGraphicsRequirementsOpenGLESKHR>(
            XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR);
        check(
            function<PFN_xrGetOpenGLESGraphicsRequirementsKHR>(
                instance, "xrGetOpenGLESGraphicsRequirementsKHR")(instance, system, &requirements),
            "GLES requirements");
        display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (!eglInitialize(display, nullptr, nullptr))
            throw std::runtime_error("eglInitialize failed");
        const EGLint attributes[]{EGL_RENDERABLE_TYPE,
                                  EGL_OPENGL_ES3_BIT,
                                  EGL_SURFACE_TYPE,
                                  EGL_PBUFFER_BIT,
                                  EGL_RED_SIZE,
                                  8,
                                  EGL_GREEN_SIZE,
                                  8,
                                  EGL_BLUE_SIZE,
                                  8,
                                  EGL_ALPHA_SIZE,
                                  8,
                                  EGL_NONE};
        EGLConfig config;
        EGLint configs = 0;
        if (!eglChooseConfig(display, attributes, &config, 1, &configs) || !configs)
            throw std::runtime_error("No GLES3 EGL config");
        const EGLint contextAttributes[]{EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
        context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
        const EGLint pbufferAttributes[]{EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE};
        surface = eglCreatePbufferSurface(display, config, pbufferAttributes);
        if (!eglMakeCurrent(display, surface, surface, context))
            throw std::runtime_error("eglMakeCurrent failed");
        LOG("GPU %s; %s", glGetString(GL_RENDERER), glGetString(GL_VERSION));
        LOG("GL_EXTENSIONS %s", glGetString(GL_EXTENSIONS));
        if (strstr(reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS)),
                   "GL_QCOM_texture_foveated")) {
            textureFoveation = reinterpret_cast<PFNGLTEXTUREFOVEATIONPARAMETERSQCOMPROC>(
                eglGetProcAddress("glTextureFoveationParametersQCOM"));
        }
        auto graphics = office::structure<XrGraphicsBindingOpenGLESAndroidKHR>(
            XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR);
        graphics.display = display;
        graphics.config = config;
        graphics.context = context;
        auto sessionInfo = office::structure<XrSessionCreateInfo>(XR_TYPE_SESSION_CREATE_INFO);
        sessionInfo.next = &graphics;
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
        panelInfo.width = 1024;
        panelInfo.height = 192;
        jobject statusSurface = nullptr;
        check(function<PFN_xrCreateSwapchainAndroidSurfaceKHR>(
                  instance, "xrCreateSwapchainAndroidSurfaceKHR")(session, &panelInfo,
                                                                  &statusSwapchain, &statusSurface),
              "create status swapchain");
        activityClass = env->GetObjectClass(activity);
        env->CallVoidMethod(
            activity,
            env->GetMethodID(activityClass, "onStatusSurface", "(Landroid/view/Surface;II)V"),
            statusSurface, 1024, 192);
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
        uint32_t formatCount;
        check(xrEnumerateSwapchainFormats(session, 0, &formatCount, nullptr), "format count");
        std::vector<int64_t> formats(formatCount);
        check(xrEnumerateSwapchainFormats(session, formatCount, &formatCount, formats.data()),
              "formats");
        int64_t format = GL_SRGB8_ALPHA8;
        if (std::find(formats.begin(), formats.end(), format) == formats.end())
            format = GL_RGBA8;
        const char *glExtensions = reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS));
        multiview = strstr(glExtensions, "GL_OVR_multiview2") != nullptr;
        attachMultiview = reinterpret_cast<PFNGLFRAMEBUFFERTEXTUREMULTIVIEWOVRPROC>(
            eglGetProcAddress("glFramebufferTextureMultiviewOVR"));
        attachMultisampleMultiview =
            reinterpret_cast<PFNGLFRAMEBUFFERTEXTUREMULTISAMPLEMULTIVIEWOVRPROC>(
                eglGetProcAddress("glFramebufferTextureMultisampleMultiviewOVR"));
        multiview = multiview && attachMultiview;
        if (!strstr(glExtensions, "GL_OVR_multiview_multisampled_render_to_texture") ||
            !attachMultisampleMultiview)
            samples = 1;
        GLint worldMaxTexture = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &worldMaxTexture);
        const office::ResolutionLimits commonLimits{
            {static_cast<int>(
                 std::max(views[0].recommendedImageRectWidth, views[1].recommendedImageRectWidth)),
             static_cast<int>(std::max(views[0].recommendedImageRectHeight,
                                       views[1].recommendedImageRectHeight))},
            {static_cast<int>(std::min({views[0].maxImageRectWidth, views[1].maxImageRectWidth,
                                        systemProperties.graphicsProperties.maxSwapchainImageWidth,
                                        static_cast<uint32_t>(worldMaxTexture)})),
             static_cast<int>(std::min({views[0].maxImageRectHeight, views[1].maxImageRectHeight,
                                        systemProperties.graphicsProperties.maxSwapchainImageHeight,
                                        static_cast<uint32_t>(worldMaxTexture)}))}};
        if (commonLimits.recommended.width < 2 || commonLimits.recommended.height < 2 ||
            commonLimits.maximum.width < 2 || commonLimits.maximum.height < 2)
            throw std::runtime_error("Invalid world eye resolution limits");
        worldLimits.fill(commonLimits);
        worldFormat = format;
        swapchainFoveation = foveation;
        auto initialTargets = worldTargetRequest(1.f, true);
        if (!replaceWorldTargets(initialTargets)) {
            LOG("FOVEATION_UNAVAILABLE %s", graphicsError.c_str());
            initialTargets.foveated = false;
            if (!replaceWorldTargets(initialTargets))
                throw std::runtime_error(graphicsError);
            textureFoveation = nullptr;
        }
        targetChanges.reset(initialTargets);
        LOG("VIEW recommended=%dx%d max=%dx%d maxScale=%.6f", commonLimits.recommended.width,
            commonLimits.recommended.height, commonLimits.maximum.width,
            commonLimits.maximum.height, office::maximumRenderScale(commonLimits));
        if (sharpScreensAvailable) {
            GLint maxTextureSize = 0;
            glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTextureSize);
            for (int i = 0; i < (multiview ? 1 : 2); ++i) {
                auto &eye = sharpEyes[i];
                const auto maxWidth =
                    multiview ? std::min(views[0].maxImageRectWidth, views[1].maxImageRectWidth)
                              : views[i].maxImageRectWidth;
                const auto maxHeight =
                    multiview ? std::min(views[0].maxImageRectHeight, views[1].maxImageRectHeight)
                              : views[i].maxImageRectHeight;
                eye.width =
                    std::min({maxWidth, systemProperties.graphicsProperties.maxSwapchainImageWidth,
                              static_cast<uint32_t>(maxTextureSize)});
                eye.height = std::min({maxHeight,
                                       systemProperties.graphicsProperties.maxSwapchainImageHeight,
                                       static_cast<uint32_t>(maxTextureSize)});
                auto sc = office::structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
                // Screen text bypasses world foveation and the world render-scale setting.
                sc.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
                sc.format = format;
                sc.sampleCount = 1;
                sc.width = eye.width;
                sc.height = eye.height;
                sc.faceCount = 1;
                sc.arraySize = multiview ? 2 : 1;
                sc.mipCount = 1;
                check(xrCreateSwapchain(session, &sc, &eye.swapchain),
                      "create sharp screen swapchain");
                check(xrEnumerateSwapchainImages(eye.swapchain, 0, &count, nullptr),
                      "sharp image count");
                eye.images.resize(count, office::structure<XrSwapchainImageOpenGLESKHR>(
                                             XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR));
                check(xrEnumerateSwapchainImages(
                          eye.swapchain, count, &count,
                          reinterpret_cast<XrSwapchainImageBaseHeader *>(eye.images.data())),
                      "sharp images");
                LOG("SHARP_SCREENS eye=%d size=%dx%d images=%u foveated=0", i, eye.width,
                    eye.height, count);
            }
            glGenFramebuffers(1, &sharpFramebuffer);
#ifndef NDEBUG
            depthProbe = std::make_unique<office::DepthProbe>();
            if (!depthProbe->initialize(multiview))
                depthProbe.reset();
#endif
        }
        LOG("RENDER_PATH multiview=%d samples=%d eye=%dx%d", multiview, samples, eyes[0].width,
            eyes[0].height);
        office::SceneRendererOptions sceneOptions;
        sceneOptions.multiview = multiview;
        sceneOptions.srgbFramebuffer = format == GL_SRGB8_ALPHA8;
        sceneOptions.maxPacketBytes = 4u << 20;
        sceneRenderer = std::make_unique<office::SceneRenderer>(sceneOptions);
        if (!sceneRenderer->initialize())
            throw std::runtime_error(sceneRenderer->lastError());
        {
            std::lock_guard<std::mutex> lock(sceneConsumerMutex);
            sceneConsumer = [this](const std::string &packet) {
                if (!sceneRenderer->enqueueJson(packet))
                    LOG("SCENE_ERROR %s", sceneRenderer->lastError().c_str());
            };
            sceneAccepts = [this] { return sceneRenderer->acceptsPackets(); };
            sceneResetNeeded = [this] { return sceneRenderer->takeResetRequest(); };
            for (const auto &packet : scenePending)
                sceneConsumer(packet);
            scenePending.clear();
            scenePendingBytes = 0;
        }
        inputRenderer = std::make_unique<office::InputRenderer>();
        jclass assetClass = env->GetObjectClass(activity);
        jobject assets = env->CallObjectMethod(
            activity,
            env->GetMethodID(assetClass, "getAssets", "()Landroid/content/res/AssetManager;"));
        inputRenderer->initialize(multiview, format == GL_SRGB8_ALPHA8,
                                  AAssetManager_fromJava(env, assets));
        env->DeleteLocalRef(assets);
        env->DeleteLocalRef(assetClass);
        cursor = std::make_unique<office::CursorSwapchain>();
        cursor->initialize(session, format);
    }

    void loop() {
        office::FrameMetrics metrics;
        office::PanelHover hover;
        office::RigPresentation presentation;
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
            // Slider release/presets select an actual target size. Keep the old targets until
            // the selection settles, and create unfoveated targets for Off: QCOM texture
            // foveation cannot be disabled once enabled on an existing texture.
            const auto desiredTargets =
                worldTargetRequest(controls.graphics.renderScale,
                                   controls.graphics.foveation != office::FoveationQuality::Off);
            if (focused && poseValid && frame.shouldRender &&
                targetChanges.observe(desiredTargets, nowMs))
                targetChanges.finish(desiredTargets, replaceWorldTargets(desiredTargets));
            if (desiredTargets.size[0] == office::RenderSize{eyes[0].width, eyes[0].height} &&
                desiredTargets.foveated == worldFoveated)
                graphicsError.clear();
            // Only the local render snapshot is smoothed. Native tracked poses remain
            // current, and gameplay, collision, picking and server state are unchanged.
            presentation.present(
                controls,
                std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count(),
                focused && poseValid && frame.shouldRender);
            controls.panelOpen = controls.panelOpen || overlayOpen;
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
            }
            XrPosef gazePose;
            bool gazeValid = input->gazePose(space, frame.predictedDisplayTime, gazePose);
            inputRenderer->update(inputFrame, controls, panelPose, controls.panelOpen);
            std::array<office::Matrix, 2> localViews;
            office::SceneEye worldViews[2];
            auto rigView = office::inverseRigid(controls.rig);
            for (int i = 0; i < 2; i++) {
                // Controllers and world share clip planes so their depth values agree.
                auto worldProjection = office::projection(views[i].fov, .05f, 320.f);
                localViews[i] = office::multiply(worldProjection, office::inverse(views[i].pose));
                auto worldView = office::multiply(office::inverse(views[i].pose), rigView);
                // The desktop office uses HAZE_MAX + 20 = 320 metres.
                std::copy(worldView.begin(), worldView.end(), worldViews[i].view);
                std::copy(worldProjection.begin(), worldProjection.end(), worldViews[i].projection);
            }
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
            if (valid)
                sceneRenderer->prepareFrame();
            office::SharpScreenPlan sharpPlan;
            bool sharp = valid && sharpScreensAvailable && controls.graphics.sharpScreens &&
                         controls.fade < .999f;
            if (sharp) {
                const auto &right = sharpEyes[multiview ? 0 : 1];
                const int widths[2]{sharpEyes[0].width, right.width},
                    heights[2]{sharpEyes[0].height, right.height};
                sharp = sceneRenderer->planSharpScreens(worldViews, widths, heights, multiview,
                                                        sharpPlan);
            }
            if (valid)
                for (int pass = 0; pass < (multiview ? 1 : 2); pass++) {
                    auto &eye = eyes[pass];
                    uint32_t imageIndex;
                    auto acquire = office::structure<XrSwapchainImageAcquireInfo>(
                        XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
                    check(xrAcquireSwapchainImage(eye.swapchain, &acquire, &imageIndex),
                          "acquire eye");
                    auto imageWait = office::structure<XrSwapchainImageWaitInfo>(
                        XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
                    imageWait.timeout = XR_INFINITE_DURATION;
                    check(xrWaitSwapchainImage(eye.swapchain, &imageWait), "wait eye");
                    const auto rect = office::renderRect(eye.width, eye.height, 1.f);
                    const auto profile =
                        office::foveationProfile(controls.graphics.foveation, gazeValid);
                    if (worldFoveated && textureFoveation) {
                        if (eye.foveationDensity[imageIndex] !=
                            controls.graphics.peripheralDensity) {
                            const GLenum target = multiview ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
                            glActiveTexture(GL_TEXTURE0);
                            glBindTexture(target, eye.images[imageIndex].image);
                            glTexParameterf(target, GL_TEXTURE_FOVEATED_MIN_PIXEL_DENSITY_QCOM,
                                            controls.graphics.peripheralDensity);
                            eye.foveationDensity[imageIndex] = controls.graphics.peripheralDensity;
                        }
                        for (int layer = 0; layer < (multiview ? 2 : 1); layer++) {
                            int i = multiview ? layer : pass;
                            auto direction =
                                gazeValid ? office::rotate(
                                                office::conjugate(views[i].pose.orientation),
                                                office::rotate(gazePose.orientation, {0, 0, -1}))
                                          : XrVector3f{0, 0, -1};
                            float tx = direction.x / std::max(.01f, -direction.z),
                                  ty = direction.y / std::max(.01f, -direction.z);
                            float l = std::tan(views[i].fov.angleLeft),
                                  r = std::tan(views[i].fov.angleRight),
                                  b = std::tan(views[i].fov.angleDown),
                                  t = std::tan(views[i].fov.angleUp);
                            float fx = std::clamp(2 * (tx - l) / (r - l) - 1, -1.f, 1.f),
                                  fy = std::clamp(2 * (ty - b) / (t - b) - 1, -1.f, 1.f);
                            const auto focalPoint = office::textureFocalPoint(
                                rect, eye.width, eye.height, gazeValid ? fx : 0.f,
                                gazeValid ? fy : 0.f);
                            // Every focal point contributes a maximum density; an untouched
                            // default point would force the entire eye to full resolution.
                            // Gaze loss uses a broader centered fovea while retaining headroom.
                            // Workspace text is in its separate, unfoveated compositor layer.
                            for (int focal = 0; focal < focalPoints; ++focal)
                                textureFoveation(eye.images[imageIndex].image, layer, focal,
                                                 focalPoint[0], focalPoint[1], profile.gain,
                                                 profile.gain, profile.area);
                        }
                    }
                    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
                    attachWorldImage(eye, imageIndex, depthTexture);
                    auto status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
                    if (status != GL_FRAMEBUFFER_COMPLETE)
                        throw std::runtime_error("Projection framebuffer incomplete: " +
                                                 std::to_string(status));
                    glViewport(rect.x, rect.y, rect.width, rect.height);
                    if (multiview)
                        sceneRenderer->renderStereo(worldViews, rect.height);
                    else
                        sceneRenderer->render(worldViews[pass], rect.height);
                    inputRenderer->render(localViews[pass], localViews[multiview ? 1 : pass],
                                          controls.fade);
                    // The sharp pass samples this depth, including the native motion controllers.
                    // Unbinding resolves tile MSAA; invalidating the sampled depth would lose
                    // occlusion, so only the texels the planned pass never reads are dropped.
                    const office::SharpScreenDepth screenDepth{
                        depthTexture,
                        multiview,
                        0,
                        {static_cast<float>(rect.x) / eye.width,
                         static_cast<float>(rect.y) / eye.height,
                         static_cast<float>(rect.width) / eye.width,
                         static_cast<float>(rect.height) / eye.height}};
                    GLenum discard = GL_DEPTH_ATTACHMENT;
#ifndef NDEBUG
                    // The one-shot probe reads the whole depth texture.
                    const bool keepAllDepth = sharp && depthProbe;
#else
                    const bool keepAllDepth = false;
#endif
                    if (!sharp) {
                        glInvalidateFramebuffer(GL_FRAMEBUFFER, 1, &discard);
                    } else if (!keepAllDepth) {
                        int keep[4]{}, other[4]{}, spans[4][4]{};
                        office::sharpDepthRegion(sharpPlan, pass, screenDepth.uvRect, eye.width,
                                                 eye.height, keep);
                        if (multiview) {
                            // Both layers share one invalidate: keep what either view samples.
                            office::sharpDepthRegion(sharpPlan, 1, screenDepth.uvRect, eye.width,
                                                     eye.height, other);
                            const int x0 = std::min(keep[0], other[0]),
                                      y0 = std::min(keep[1], other[1]);
                            const int x1 = std::max(keep[0] + keep[2], other[0] + other[2]),
                                      y1 = std::max(keep[1] + keep[3], other[1] + other[3]);
                            keep[0] = x0;
                            keep[1] = y0;
                            keep[2] = x1 - x0;
                            keep[3] = y1 - y0;
                        }
                        const int n = office::sharpComplement(keep, eye.width, eye.height, spans);
                        for (int k = 0; k < n; ++k)
                            glInvalidateSubFramebuffer(GL_FRAMEBUFFER, 1, &discard, spans[k][0],
                                                       spans[k][1], spans[k][2], spans[k][3]);
                    }
                    glBindFramebuffer(GL_FRAMEBUFFER, 0);
                    if (sharp) {
#ifndef NDEBUG
                        if (depthProbe) {
                            const auto result = depthProbe->sample(depthTexture, multiview);
                            LOG("SHARP_DEPTH_PROBE covered=%d zero=%d maximum=%d samples=%d "
                                "error=%x",
                                result.covered, result.zero, result.maximum, samples, result.error);
                            depthProbe.reset();
                        }
#endif
                        auto &screenEye = sharpEyes[pass];
                        uint32_t screenImageIndex = 0;
                        check(xrAcquireSwapchainImage(screenEye.swapchain, &acquire,
                                                      &screenImageIndex),
                              "acquire sharp screen");
                        check(xrWaitSwapchainImage(screenEye.swapchain, &imageWait),
                              "wait sharp screen");
                        glBindFramebuffer(GL_FRAMEBUFFER, sharpFramebuffer);
                        if (multiview)
                            attachMultiview(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                            screenEye.images[screenImageIndex].image, 0, 0, 2);
                        else
                            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                                   GL_TEXTURE_2D,
                                                   screenEye.images[screenImageIndex].image, 0);
                        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
                            throw std::runtime_error("Sharp screen framebuffer incomplete");
                        glViewport(0, 0, screenEye.width, screenEye.height);
                        // Clears and draws only the planned region; the rest is never presented.
                        sceneRenderer->renderSharpScreens(sharpPlan, pass, screenDepth,
                                                          controls.fade);
                        glBindFramebuffer(GL_FRAMEBUFFER, 0);
                        auto screenRelease = office::structure<XrSwapchainImageReleaseInfo>(
                            XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                        check(xrReleaseSwapchainImage(screenEye.swapchain, &screenRelease),
                              "release sharp screen");
                    }
                    glFlush();
                    auto release = office::structure<XrSwapchainImageReleaseInfo>(
                        XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                    check(xrReleaseSwapchainImage(eye.swapchain, &release), "release eye");
                }
            for (int i = 0; i < 2; i++) {
                auto &eye = eyes[multiview ? 0 : i];
                auto &pv = projectionViews[i];
                pv = office::structure<XrCompositionLayerProjectionView>(
                    XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW);
                pv.pose = views[i].pose;
                pv.fov = views[i].fov;
                pv.subImage.swapchain = eye.swapchain;
                pv.subImage.imageArrayIndex = multiview ? i : 0;
                const auto rect = office::renderRect(eye.width, eye.height, 1.f);
                pv.subImage.imageRect.offset = {rect.x, rect.y};
                pv.subImage.imageRect.extent = {rect.width, rect.height};
                if (sharp) {
                    auto &screenEye = sharpEyes[multiview ? 0 : i];
                    auto &screenView = sharpProjectionViews[i];
                    screenView = office::structure<XrCompositionLayerProjectionView>(
                        XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW);
                    screenView.pose = views[i].pose;
                    // Only the screens' pixels are presented, with the edges they span in the
                    // eye's whole image (GLES image origin bottom-left, as viewRect), so every
                    // pixel lands where the whole-image layer put it.
                    const int *crop = sharpPlan.viewRect[i];
                    const office::SharpTangents whole{
                        std::tan(views[i].fov.angleLeft), std::tan(views[i].fov.angleRight),
                        std::tan(views[i].fov.angleDown), std::tan(views[i].fov.angleUp)};
                    const auto sub =
                        office::sharpSubTangents(whole, screenEye.width, screenEye.height, crop);
                    screenView.fov = {std::atan(sub.left), std::atan(sub.right), std::atan(sub.up),
                                      std::atan(sub.down)};
                    screenView.subImage.swapchain = screenEye.swapchain;
                    screenView.subImage.imageArrayIndex = multiview ? i : 0;
                    screenView.subImage.imageRect.offset = {crop[0], crop[1]};
                    screenView.subImage.imageRect.extent = {crop[2], crop[3]};
                }
            }
            auto panel = office::structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
            panel.space = space;
            panel.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
            panel.pose = panelPose;
            panel.size = {1.8f, 1.2f};
            panel.subImage.swapchain = panelSwapchain;
            panel.subImage.imageRect.extent = {2400, 1600};
            auto status = office::structure<XrCompositionLayerQuad>(XR_TYPE_COMPOSITION_LAYER_QUAD);
            status.space = viewSpace;
            status.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
            status.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
            status.pose = {{0, 0, 0, 1}, {0, -.4f, -1.4f}};
            status.size = {.9f, .16875f};
            status.subImage.swapchain = statusSwapchain;
            status.subImage.imageRect.extent = {1024, 192};
            std::array<XrCompositionLayerQuad, 2> pointers;
            std::vector<const XrCompositionLayerBaseHeader *> layers;
            if (valid) {
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&projection));
                if (sharp)
                    layers.push_back(
                        reinterpret_cast<XrCompositionLayerBaseHeader *>(&sharpProjection));
                if (controls.panelOpen) {
                    layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&panel));
                    for (int h = 0; h < 2; h++)
                        if (cursorVisible[h]) {
                            pointers[h] = cursor->layer(space, cursorPose[h]);
                            layers.push_back(
                                reinterpret_cast<XrCompositionLayerBaseHeader *>(&pointers[h]));
                        }
                }
            }
            // VIEW-space status does not depend on valid application eye poses. Drain a pending
            // Canvas post even when the world is temporarily invalid or shouldRender is false,
            // until the UI-thread producer shutdown acknowledgment arrives.
            if (statusProducerVisible)
                layers.push_back(reinterpret_cast<XrCompositionLayerBaseHeader *>(&status));
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
                frameMetrics["sharpScreens"] = sharp;
                frameMetrics["sharpSetting"] = controls.graphics.sharpScreens;
                frameMetrics["worldRecommendedWidth"] = worldLimits[0].recommended.width;
                frameMetrics["worldRecommendedHeight"] = worldLimits[0].recommended.height;
                frameMetrics["worldMaxWidth"] = worldLimits[0].maximum.width;
                frameMetrics["worldMaxHeight"] = worldLimits[0].maximum.height;
                frameMetrics["worldWidth"] = eyes[0].width;
                frameMetrics["worldHeight"] = eyes[0].height;
                frameMetrics["maxRenderScale"] = office::maximumRenderScale(worldLimits[0]);
                frameMetrics["foveationSupported"] = textureFoveation != nullptr;
                frameMetrics["foveationEnabled"] = worldFoveated;
                frameMetrics["graphicsError"] = graphicsError;
                if (sharp) {
                    frameMetrics["sharpWidth"] = sharpEyes[0].width;
                    frameMetrics["sharpHeight"] = sharpEyes[0].height;
                    // This frame's presented crop of each eye (x, y, width, height).
                    frameMetrics["sharpCrop"] = {
                        std::vector<int>(sharpPlan.viewRect[0], sharpPlan.viewRect[0] + 4),
                        std::vector<int>(sharpPlan.viewRect[1], sharpPlan.viewRect[1] + 4)};
                }
                const auto report = frameMetrics.dump(-1, ' ', true);
                auto counters = performance->sampleJson();
                auto runtime = nlohmann::json::parse(counters);
                auto combined = std::move(frameMetrics);
                combined["runtime"] = runtime;
                auto stats = sceneRenderer->stats();
                nlohmann::json sceneMetrics = {{"objects", stats.objects},
                                               {"visible", stats.visibleObjects},
                                               {"drawCalls", stats.drawCalls},
                                               {"sharpScreens", stats.sharpScreens},
                                               {"sharpItems", stats.sharpItems},
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
                {
                    std::lock_guard<std::mutex> lock(metricsMutex);
                    latestMetrics = combined.dump(-1, ' ', true);
                }
                LOG("FRAME_METRICS %s gl_error=%x", report.c_str(), glGetError());
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
                LOG("RUNTIME_METRICS %s", displayMetrics.dump().c_str());
                LOG("SCENE_METRICS %s", sceneMetrics.dump().c_str());
                metrics.reset();
            }
        }
    }
};
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_dev_droidoffice_xr_OfficeActivity_nativeStart(JNIEnv *env, jobject activity) {
    if (renderThread.joinable())
        return;
    env->GetJavaVM(&vm);
    jobject global = env->NewGlobalRef(activity);
    stopping = false;
    focused = false;
    rebaseRequested = false;
    overlayOpen = false;
    statusProducerVisible = false;
    resetControlHeartbeat();
    observedRefreshRate = 0;
    {
        std::lock_guard<std::mutex> lock(metricsMutex);
        latestMetrics = "{}";
    }
    renderThread = std::thread([global] {
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
        try {
            Office office(threadEnv, global);
            office.init();
            office.loop();
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
    const auto report = metrics.dump(-1, ' ', true);
    return env->NewStringUTF(report.c_str());
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
    const std::string events =
        std::string("{\"resetInput\":") + (focused ? "false" : "true") +
        ",\"recenter\":" + (rebaseRequested.exchange(false) ? "true" : "false") +
        ",\"sceneReady\":" + (sceneReady ? "true" : "false") +
        ",\"sceneReset\":" + (sceneReset ? "true" : "false") + "}";
    return env->NewStringUTF(events.c_str());
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
