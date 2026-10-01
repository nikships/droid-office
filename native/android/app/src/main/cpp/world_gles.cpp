// The GLES world renderer: the office's shipping path, moved unchanged out of office_xr.cpp
// behind the WorldRenderer seam (world_renderer.h). It owns the EGL context, the world targets
// (multiview, tile MSAA) with runtime foveation and the filtered periphery, the sharp-screen
// layer, the scene, the controllers, rays and fade, and the panel cursor.
#include "world_gles.h"

#include "controller_attachment.h"
#include "cursor_swapchain.h"
#ifndef NDEBUG
#include "depth_probe.h"
#endif
#include "foveation.h"
#include "foveation_filter.h"
#include "foveation_overlay.h"
#include "input_renderer.h"
#include "layer_occlusion.h"
#include "panel_cutout.h"
#include "scene_renderer.h"
#include "xr_call.h"
#include "xr_math.h"
#include "xr_util.h"
#include <EGL/egl.h>
#include <GLES2/gl2ext.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
#include <stdexcept>
#include <string>
#include <vector>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeXR", __VA_ARGS__)

namespace {
using Clock = std::chrono::steady_clock;
using office::xr::check;
using office::xr::function;
using office::xr::optionalFunction;

struct Eye {
    XrSwapchain swapchain = XR_NULL_HANDLE;
    int width = 0, height = 0;
    std::vector<XrSwapchainImageOpenGLESKHR> images;
};

class GlesWorld final : public office::WorldRenderer {
  public:
    office::WorldHost host;
    JNIEnv *env;
    jobject activity;
    XrInstance instance = XR_NULL_HANDLE;
    XrSystemId system = XR_NULL_SYSTEM_ID;
    XrSession session = XR_NULL_HANDLE;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    GLuint framebuffer = 0, depthTexture = 0, sharpFramebuffer = 0;
    bool multiview = false;
    int samples = 4;
    PFNGLFRAMEBUFFERTEXTUREMULTIVIEWOVRPROC attachMultiview = nullptr;
    PFNGLFRAMEBUFFERTEXTUREMULTISAMPLEMULTIVIEWOVRPROC attachMultisampleMultiview = nullptr;
    std::array<Eye, 2> eyes, sharpEyes;
    std::array<office::ResolutionLimits, 2> worldLimits;
    office::RenderTargetChanges targetChanges;
    int64_t worldFormat = GL_RGBA8;
    // Runtime-owned foveation (foveation.h); the runtime, not the app, configures the QCOM texture
    // state. boundTargets: the size and foveation the current world swapchains were created with.
    // foveationProfile: the profile first applied to them, kept for the eye-tracked per-frame
    // update; null when they have no foveation support. reapplyProfile: apply it once more after
    // xrBeginSession.
    office::FoveationPolicy foveation;
    office::RenderTargetRequest boundTargets;
    bool reapplyProfile = false;
    PFN_xrCreateFoveationProfileFB createFoveationProfile = nullptr;
    PFN_xrDestroyFoveationProfileFB destroyFoveationProfile = nullptr;
    PFN_xrUpdateSwapchainFB updateSwapchain = nullptr;
    PFN_xrGetFoveationEyeTrackedStateMETA getFoveationState = nullptr;
    XrFoveationProfileFB foveationProfile = XR_NULL_HANDLE;
    XrResult profileCreateResult = XR_SUCCESS, profileUpdateResult = XR_SUCCESS;
    // Last logged per-frame eye-tracked results; a change is logged once.
    XrResult eyeUpdateLogged = XR_SUCCESS, eyeStateLogged = XR_SUCCESS;
    bool eyeResultsLogged = false;
    office::FoveationSamples foveationSamples;
    // Filtered targets (TargetFoveation::filtered): the world renders into foveatedEyes, the
    // runtime-foveated swapchains, which are never submitted; eyes are then created without
    // foveation support and receive the filtered reconstruction through filterFramebuffer.
    std::array<Eye, 2> foveatedEyes;
    GLuint filterFramebuffer = 0;
    std::unique_ptr<office::FoveationFilter> foveationFilter;
    // Read-only GL_QCOM_texture_foveated state of each rendered world image after the runtime
    // applied a profile (Table 21.10 queries): shows whether the runtime really foveates this GLES
    // texture. imageUses counts each image's frames since the targets were created; the state is
    // read on an image's second frame, because the first frame of a new image read 0 bits on the
    // headset although every frame was foveated.
    std::vector<uint8_t> imageUses;
    // Of the images probed so far, those that read no QCOM foveation bits. Filtered targets
    // whose images all read none fall back to submitting the foveated set directly.
    size_t imagesProbed = 0, imagesUnfoveated = 0;
    GLint textureBits = -1, textureFocalPoints = -1;
    GLfloat textureMinDensity = -1;
    std::unique_ptr<office::FoveationOverlay> foveationOverlay;
    std::string graphicsError;
    bool sharpScreensAvailable = false;
#ifndef NDEBUG
    std::unique_ptr<office::DepthProbe> depthProbe;
#endif
    std::unique_ptr<office::InputRenderer> inputRenderer;
    std::unique_ptr<office::PanelCutout> panelCutout;
    std::unique_ptr<office::CursorSwapchain> cursor;
    std::unique_ptr<office::SceneRenderer> sceneRenderer;

    // Bring-up state: the foveation capabilities found so far, the eye-tracked system properties
    // and the session's graphics binding.
    office::FoveationSupport fovea;
    XrSystemFoveationEyeTrackedPropertiesMETA eyeTrackedProperties{};
    XrGraphicsBindingOpenGLESAndroidKHR graphics{};
    // This frame's settings as world targets, and the latest frame's screen layer, for metrics.
    office::RenderTargetRequest desiredTargets;
    bool lastSharp = false;
    office::SharpScreenPlan lastSharpPlan;

    explicit GlesWorld(const office::WorldHost &h) : host(h), env(h.env), activity(h.activity) {}

    ~GlesWorld() override {
        // The session and instance are gone (office_xr.cpp ~Office); the context goes last.
        if (display != EGL_NO_DISPLAY) {
            eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (surface != EGL_NO_SURFACE)
                eglDestroySurface(display, surface);
            if (context != EGL_NO_CONTEXT)
                eglDestroyContext(display, context);
            eglTerminate(display);
        }
    }

    /** Android XR: XR_META_foveation_eye_tracked needs EYE_TRACKING_FINE. OfficeActivity starts
     * the native session only after its permission request returns, so one check suffices. */
    bool eyeTrackingPermission() {
        jclass cls = env->GetObjectClass(activity);
        jmethodID method = env->GetMethodID(cls, "checkSelfPermission", "(Ljava/lang/String;)I");
        env->DeleteLocalRef(cls);
        if (!method || env->ExceptionCheck()) {
            env->ExceptionClear();
            return false;
        }
        jstring name = env->NewStringUTF("android.permission.EYE_TRACKING_FINE");
        const jint result = env->CallIntMethod(activity, method, name);
        env->DeleteLocalRef(name);
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            return false;
        }
        return result == 0; // PackageManager.PERMISSION_GRANTED
    }

    office::RenderTargetRequest worldTargetRequest(float scale,
                                                   office::FoveationQuality quality) const {
        office::RenderTargetRequest request;
        request.foveation = foveation.desired(quality);
        for (int i = 0; i < (multiview ? 1 : 2); ++i)
            request.size[i] = office::renderSize(worldLimits[i], scale);
        return request;
    }

    /** The swapchains the world is rendered into: the foveated ones when filtered. */
    const std::array<Eye, 2> &renderEyes() const {
        return boundTargets.foveation.filtered ? foveatedEyes : eyes;
    }

    /** A submitted world image as the single, unfoveated colour attachment of the filter pass. */
    void attachFilteredImage(const Eye &eye, uint32_t imageIndex) {
        const auto image = eye.images[imageIndex].image;
        if (multiview)
            attachMultiview(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, image, 0, 0, 2);
        else
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, image, 0);
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

    /**
     * XrFoveationProfileCreateInfoFB -> XrFoveationLevelProfileCreateInfoFB ->
     * XrFoveationEyeTrackedProfileCreateInfoMETA (flags 0, "no eye tracked profile create flags").
     * The META struct "can be added to the next chain of XrFoveationLevelProfileCreateInfoFB in
     * order to enable eye tracked foveation" (XR_META_foveation_eye_tracked). Godot's
     * _update_profile_rt builds the same chain; Meta's ovrRenderer_SetFoveation the one without
     * the META struct.
     */
    XrResult createProfile(const office::TargetFoveation &spec,
                           XrFoveationProfileFB &profile) const {
        auto eyeTracked = office::structure<XrFoveationEyeTrackedProfileCreateInfoMETA>(
            XR_TYPE_FOVEATION_EYE_TRACKED_PROFILE_CREATE_INFO_META);
        auto level = office::structure<XrFoveationLevelProfileCreateInfoFB>(
            XR_TYPE_FOVEATION_LEVEL_PROFILE_CREATE_INFO_FB);
        level.next = spec.eyeTracked ? &eyeTracked : nullptr;
        level.level = static_cast<XrFoveationLevelFB>(spec.level);
        level.verticalOffset = 0;
        // A static pattern at the chosen level keeps each setting reproducible; DYNAMIC lets the
        // runtime change it with headroom (XR_FB_foveation_configuration).
        level.dynamic = XR_FOVEATION_DYNAMIC_DISABLED_FB;
        auto info = office::structure<XrFoveationProfileCreateInfoFB>(
            XR_TYPE_FOVEATION_PROFILE_CREATE_INFO_FB);
        info.next = &level;
        return createFoveationProfile(session, &info, &profile);
    }

    /** xrUpdateSwapchainFB with XrSwapchainStateFoveationFB (flags 0) (XR_FB_foveation). */
    XrResult applyProfile(XrSwapchain swapchain, XrFoveationProfileFB profile) const {
        auto state =
            office::structure<XrSwapchainStateFoveationFB>(XR_TYPE_SWAPCHAIN_STATE_FOVEATION_FB);
        state.profile = profile;
        return updateSwapchain(swapchain,
                               reinterpret_cast<const XrSwapchainStateBaseHeaderFB *>(&state));
    }

    /**
     * Applies the first profile to new world swapchains, right after they were created, as Godot
     * (on_main_swapchains_created -> update_profile) and Meta (ovrRenderer_Create, then
     * ovrRenderer_SetFoveation) do. If the runtime rejects the eye-tracked profile, the same
     * level without eye tracking is applied to the same new swapchains. spec receives what was
     * bound and profile the applied handle. Returns false when no level could be applied; the
     * caller then creates targets without foveation support. GL thread, no acquired world image.
     * Cached GL state is not relied on afterwards: XR_FB_swapchain_update_state_opengl_es says a
     * GLES update may alter texture bindings (assumed here as well), and every renderer rebinds
     * what it uses.
     */
    bool bindFoveation(const std::array<Eye, 2> &targets, office::TargetFoveation &spec,
                       XrFoveationProfileFB &profile) {
        for (;;) {
            XrFoveationProfileFB next = XR_NULL_HANDLE;
            const auto created = createProfile(spec, next);
            auto updated = created;
            for (int i = 0; XR_SUCCEEDED(created) && i < (multiview ? 1 : 2); ++i)
                if (XR_SUCCEEDED(updated))
                    updated = applyProfile(targets[i].swapchain, next);
            profileCreateResult = created;
            profileUpdateResult = updated;
            LOG("FOVEATION_PROFILE level=%s eyeTracked=%d create=%d update=%d",
                office::foveationLevelName(spec), spec.eyeTracked, created, updated);
            if (XR_SUCCEEDED(updated)) {
                // Kept for the eye-tracked per-frame update. "A XrFoveationProfileFB may be safely
                // destroyed after being applied to a swapchain state using xrUpdateSwapchainFB
                // without affecting the foveation parameters of the swapchain" (XR_FB_foveation).
                profile = next;
                return true;
            }
            if (next)
                destroyFoveationProfile(next);
            const bool retryFixed = foveation.rejected(spec);
            LOG("FOVEATION_FALLBACK %s", foveation.fallback());
            if (!retryFixed)
                return false;
            spec.eyeTracked = false;
        }
    }

    /**
     * Called only on the GL thread with no acquired world images. Keep old targets on failure. On
     * success boundTargets holds the size and the foveation actually bound, which is below the
     * request when the runtime rejected its eye-tracked profile. Filtered targets are two sets of
     * the same size: the submitted swapchains without foveation support, and the foveated ones the
     * world renders into, which are sampled by the filter pass and never submitted.
     */
    bool replaceWorldTargets(const office::RenderTargetRequest &request) {
        std::array<Eye, 2> next, nextFoveated;
        GLuint nextDepth = 0, nextFramebuffer = 0, nextFilterFramebuffer = 0;
        XrSwapchain acquired = XR_NULL_HANDLE;
        bool waited = false;
        auto bound = request.foveation;
        bound.filtered = bound.foveated() && bound.filtered && foveationFilter;
        XrFoveationProfileFB nextProfile = XR_NULL_HANDLE;
        try {
            glActiveTexture(GL_TEXTURE0);
            const auto createSet = [&](std::array<Eye, 2> &set, bool foveated, bool sampled) {
                for (int i = 0; i < (multiview ? 1 : 2); ++i) {
                    auto &eye = set[i];
                    eye.width = request.size[i].width;
                    eye.height = request.size[i].height;
                    auto sc =
                        office::structure<XrSwapchainCreateInfo>(XR_TYPE_SWAPCHAIN_CREATE_INFO);
                    auto foveatedInfo = office::structure<XrSwapchainCreateInfoFoveationFB>(
                        XR_TYPE_SWAPCHAIN_CREATE_INFO_FOVEATION_FB);
                    // "Explicitly create the swapchain with scaled bin foveation support. The
                    // application must ensure that the swapchain is using the OpenGL graphics API
                    // and that the QCOM_texture_foveated extension is supported and enabled"
                    // (registry, XrSwapchainCreateFoveationFlagBitsFB). Godot uses this flag for
                    // GLES. Only the world colour swapchain the world renders into is foveated:
                    // never depth (QCOM: an incomplete framebuffer), the sharp-screen layer, the
                    // Android Surface panels or the submitted copy of filtered targets. Off leaves
                    // it out: such a swapchain has no foveation support (XR_FB_foveation).
                    foveatedInfo.flags = XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB;
                    sc.next = foveated ? &foveatedInfo : nullptr;
                    // The filter pass samples the foveated world image (core usage flag).
                    sc.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT |
                                    (sampled ? XR_SWAPCHAIN_USAGE_SAMPLED_BIT : 0);
                    sc.format = worldFormat;
                    sc.sampleCount = 1;
                    sc.width = eye.width;
                    sc.height = eye.height;
                    sc.faceCount = 1;
                    sc.arraySize = multiview ? 2 : 1;
                    sc.mipCount = 1;
                    check(xrCreateSwapchain(session, &sc, &eye.swapchain),
                          foveated ? "create foveated world swapchain" : "create world swapchain");
                    uint32_t count = 0;
                    check(xrEnumerateSwapchainImages(eye.swapchain, 0, &count, nullptr),
                          "world image count");
                    eye.images.resize(count, office::structure<XrSwapchainImageOpenGLESKHR>(
                                                 XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR));
                    check(xrEnumerateSwapchainImages(
                              eye.swapchain, count, &count,
                              reinterpret_cast<XrSwapchainImageBaseHeader *>(eye.images.data())),
                          "world images");
                }
            };
            createSet(next, bound.foveated() && !bound.filtered, false);
            if (bound.filtered)
                createSet(nextFoveated, true, true);
            const auto &render = bound.filtered ? nextFoveated : next;
            // The first profile, before the swapchains are used. The runtime keeps it: later
            // profiles did not change a Galaxy XR world swapchain (foveation.h).
            if (bound.foveated() && !bindFoveation(render, bound, nextProfile))
                throw std::runtime_error(std::string("Foveation profile rejected: ") +
                                         foveation.fallback());
            glActiveTexture(GL_TEXTURE0);
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
            // Exercise the exact render attachment paths before replacing the existing targets.
            glGenFramebuffers(1, &nextFramebuffer);
            if (bound.filtered)
                glGenFramebuffers(1, &nextFilterFramebuffer);
            const auto validate = [&](const Eye &eye, bool world) {
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
                glBindFramebuffer(GL_FRAMEBUFFER, world ? nextFramebuffer : nextFilterFramebuffer);
                if (world)
                    attachWorldImage(eye, imageIndex, nextDepth);
                else
                    attachFilteredImage(eye, imageIndex);
                const auto status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
                if (status != GL_FRAMEBUFFER_COMPLETE)
                    throw std::runtime_error(
                        std::string(world ? "World" : "Filtered world") +
                        " target framebuffer incomplete: " + std::to_string(status));
                glDisable(GL_SCISSOR_TEST);
                glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
                glDepthMask(GL_TRUE);
                glClearColor(0, 0, 0, 1);
                glClearDepthf(1);
                glClear(world ? GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT : GL_COLOR_BUFFER_BIT);
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
            };
            for (int i = 0; i < (multiview ? 1 : 2); ++i) {
                validate(render[i], true);
                if (bound.filtered)
                    validate(next[i], false);
            }
        } catch (const std::exception &error) {
            graphicsError = error.what();
            LOG("WORLD_TARGET_REJECTED filtered=%d %s", bound.filtered, graphicsError.c_str());
            // The current targets keep the profile they were created with.
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            glFinish();
            if (nextFramebuffer)
                glDeleteFramebuffers(1, &nextFramebuffer);
            if (nextFilterFramebuffer)
                glDeleteFramebuffers(1, &nextFilterFramebuffer);
            if (acquired && waited) {
                auto release = office::structure<XrSwapchainImageReleaseInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                xrReleaseSwapchainImage(acquired, &release);
            }
            if (nextDepth)
                glDeleteTextures(1, &nextDepth);
            for (auto *set : {&next, &nextFoveated})
                for (auto &eye : *set)
                    if (eye.swapchain)
                        xrDestroySwapchain(eye.swapchain);
            if (nextProfile)
                destroyFoveationProfile(nextProfile);
            return false;
        }
        // Validation completed prior GPU image use and released every staged image.
        // Keep the validated framebuffers; no synchronization is added to the display loop.
        std::swap(eyes, next);
        std::swap(foveatedEyes, nextFoveated);
        std::swap(depthTexture, nextDepth);
        std::swap(framebuffer, nextFramebuffer);
        std::swap(filterFramebuffer, nextFilterFramebuffer);
        if (nextFramebuffer)
            glDeleteFramebuffers(1, &nextFramebuffer);
        if (nextFilterFramebuffer)
            glDeleteFramebuffers(1, &nextFilterFramebuffer);
        if (nextDepth)
            glDeleteTextures(1, &nextDepth);
        for (auto *set : {&next, &nextFoveated})
            for (auto &eye : *set)
                if (eye.swapchain)
                    xrDestroySwapchain(eye.swapchain);
        // No call uses the old profile any more (XR_FB_foveation, xrDestroyFoveationProfileFB).
        if (foveationProfile)
            destroyFoveationProfile(foveationProfile);
        foveationProfile = nextProfile;
        boundTargets = {request.size, bound};
        // Read the QCOM state of every rendered world image, foveated or not, once.
        imageUses.assign(foveation.capabilities().qcomTexture ? renderEyes()[0].images.size() : 0,
                         0);
        imagesProbed = imagesUnfoveated = 0;
        eyeResultsLogged = false;
        foveationSamples.reset();
        graphicsError.clear();
        LOG("WORLD_TARGET size=%dx%d foveated=%d level=%s eyeTracked=%d filtered=%d", eyes[0].width,
            eyes[0].height, bound.foveated(), office::foveationLevelName(bound), bound.eyeTracked,
            bound.filtered);
        return true;
    }

    /** The diagnostic view's centre: reported, the image-centre fallback, or none for Off. */
    office::FoveaMarker foveaMarker(bool reportedValid) const {
        if (reportedValid)
            return office::FoveaMarker::Reported;
        return boundTargets.foveation.foveated() ? office::FoveaMarker::ImageCentre
                                                 : office::FoveaMarker::None;
    }

    /** The bound foveation and this metrics window's eye-tracked results. */
    nlohmann::json foveationMetrics(const office::GraphicsControls &graphics,
                                    const office::RenderTargetRequest &desired) const {
        const auto &s = foveationSamples;
        nlohmann::json fovea = {
            {"setting", office::foveationQualityName(graphics.foveation)},
            {"level", office::foveationLevelName(boundTargets.foveation)},
            {"eyeTracked", boundTargets.foveation.eyeTracked},
            {"eyeTrackedAvailable", foveation.eyeTrackedAvailable()},
            // Reduced regions are filtered into the submitted image rather than submitted in
            // the driver's upscaled blocks.
            {"filtered", boundTargets.foveation.filtered},
            {"filterAvailable", foveation.filterAvailable()},
            // The setting asks for other targets than the bound ones; they follow shortly.
            {"pending", desired.foveation != boundTargets.foveation},
            {"create", profileCreateResult},
            {"update", profileUpdateResult},
            {"frames", s.frames},
            {"validFrames", s.valid},
            {"invalidFrames", s.invalid},
            {"failedFrames", s.failed},
            {"lastUpdate", s.update},
            {"lastState", s.state},
            {"centerValid", s.centerValid},
            {"textureBits", textureBits},
            {"textureMinDensity", textureMinDensity},
            {"textureFocalPoints", textureFocalPoints},
            {"debug", graphics.foveationDebug},
            {"fallback", foveation.fallback()}};
        if (s.centerValid)
            fovea["center"] = {{s.center[0].x, s.center[0].y}, {s.center[1].x, s.center[1].y}};
        return fovea;
    }

    /**
     * Puts newly bound world targets into the page's metrics at once rather than at the next
     * five-second window, so the menu reports what is bound right after a change.
     */
    void publishTargets(office::FoveationQuality setting) {
        host.editMetrics([&](nlohmann::json &metrics) {
            metrics["worldWidth"] = eyes[0].width;
            metrics["worldHeight"] = eyes[0].height;
            metrics["foveationSupported"] = foveation.swapchainFoveation();
            metrics["foveationEnabled"] = boundTargets.foveation.foveated();
            metrics["foveationLevel"] = office::foveationLevelName(boundTargets.foveation);
            auto &fovea = metrics["foveation"];
            if (!fovea.is_object())
                fovea = nlohmann::json::object();
            fovea["setting"] = office::foveationQualityName(setting);
            fovea["level"] = office::foveationLevelName(boundTargets.foveation);
            fovea["eyeTracked"] = boundTargets.foveation.eyeTracked;
            fovea["eyeTrackedAvailable"] = foveation.eyeTrackedAvailable();
            fovea["filtered"] = boundTargets.foveation.filtered;
            fovea["filterAvailable"] = foveation.filterAvailable();
            fovea["pending"] = false;
            fovea["fallback"] = foveation.fallback();
        });
    }

    // ---- WorldRenderer: bring-up ----------------------------------------------------------------

    const char *graphicsExtension() const override {
        return XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME;
    }

    void instanceExtensions(const std::function<bool(const char *)> &supports, bool gaze,
                            std::vector<const char *> &extensions) override {
        // Runtime foveation, enabled only as advertised and within the registry's dependencies:
        // XR_FB_foveation needs XR_FB_swapchain_update_state; XR_FB_foveation_configuration needs
        // XR_FB_foveation; XR_META_foveation_eye_tracked needs both FB foveation extensions.
        // XR_FB_swapchain_update_state_opengl_es only carries GLES sampler state and is not
        // needed (this runtime does not advertise it).
        fovea.updateState = supports(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME);
        fovea.fbFoveation = fovea.updateState && supports(XR_FB_FOVEATION_EXTENSION_NAME);
        fovea.configuration =
            fovea.fbFoveation && supports(XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME);
        fovea.metaEyeTracked =
            fovea.configuration && supports(XR_META_FOVEATION_EYE_TRACKED_EXTENSION_NAME);
        fovea.eyeGaze = gaze;
        if (fovea.fbFoveation) {
            extensions.push_back(XR_FB_SWAPCHAIN_UPDATE_STATE_EXTENSION_NAME);
            extensions.push_back(XR_FB_FOVEATION_EXTENSION_NAME);
        }
        if (fovea.configuration)
            extensions.push_back(XR_FB_FOVEATION_CONFIGURATION_EXTENSION_NAME);
        if (fovea.metaEyeTracked)
            extensions.push_back(XR_META_FOVEATION_EYE_TRACKED_EXTENSION_NAME);
    }

    void *systemProperties(void *next) override {
        // XrSystemFoveationEyeTrackedPropertiesMETA: "An application can inspect whether the
        // system is capable of eye tracked foveation" (XR_META_foveation_eye_tracked).
        eyeTrackedProperties = office::structure<XrSystemFoveationEyeTrackedPropertiesMETA>(
            XR_TYPE_SYSTEM_FOVEATION_EYE_TRACKED_PROPERTIES_META);
        if (fovea.metaEyeTracked) {
            eyeTrackedProperties.next = next;
            return &eyeTrackedProperties;
        }
        return next;
    }

    const void *createDevice(XrInstance xrInstance, XrSystemId xrSystem,
                             const XrSystemProperties &systemProperties, bool gazeSystem) override {
        instance = xrInstance;
        system = xrSystem;
        fovea.systemEyeTracked =
            fovea.metaEyeTracked && eyeTrackedProperties.supportsFoveationEyeTracked == XR_TRUE;
        if (fovea.fbFoveation) {
            // Function pointers per Meta's ovrRenderer_SetFoveation and Godot's
            // OpenXRFBFoveationExtension::on_instance_created. A missing one disables foveation.
            createFoveationProfile = optionalFunction<PFN_xrCreateFoveationProfileFB>(
                instance, "xrCreateFoveationProfileFB");
            destroyFoveationProfile = optionalFunction<PFN_xrDestroyFoveationProfileFB>(
                instance, "xrDestroyFoveationProfileFB");
            updateSwapchain =
                optionalFunction<PFN_xrUpdateSwapchainFB>(instance, "xrUpdateSwapchainFB");
            fovea.fbFoveation =
                createFoveationProfile && destroyFoveationProfile && updateSwapchain;
        }
        if (fovea.metaEyeTracked) {
            getFoveationState = optionalFunction<PFN_xrGetFoveationEyeTrackedStateMETA>(
                instance, "xrGetFoveationEyeTrackedStateMETA");
            fovea.metaEyeTracked = getFoveationState != nullptr;
        }
        // World + sharp screens + workspace + two pointers + the status shutdown handshake,
        // which uses one status column while the workspace is open (status_layout.h).
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
        // The SCALED_BIN swapchain flag requires GL_QCOM_texture_foveated. The runtime, not the
        // app, sets its texture state, so glTextureFoveationParametersQCOM is not loaded.
        fovea.qcomTexture = strstr(reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS)),
                                   "GL_QCOM_texture_foveated") != nullptr;
        fovea.eyePermission = eyeTrackingPermission();
        foveation = office::FoveationPolicy(fovea);
        LOG("FOVEATION_CAPABILITY fb=%d configuration=%d updateState=%d qcom=%d meta=%d "
            "systemEyeTracked=%d permission=%d eyeGaze=%d gazeSystem=%d runtime=%d eyeTracked=%d",
            fovea.fbFoveation, fovea.configuration, fovea.updateState, fovea.qcomTexture,
            fovea.metaEyeTracked, fovea.systemEyeTracked, fovea.eyePermission, fovea.eyeGaze,
            gazeSystem, office::runtimeFoveation(fovea), office::eyeTrackedFoveation(fovea));
        graphics = office::structure<XrGraphicsBindingOpenGLESAndroidKHR>(
            XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR);
        graphics.display = display;
        graphics.config = config;
        graphics.context = context;
        return &graphics;
    }

    void createTargets(XrSession xrSession, const std::vector<XrViewConfigurationView> &views,
                       const XrSystemProperties &systemProperties) override {
        session = xrSession;
        uint32_t count = 0;
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
        {
            // The filtered reconstruction of foveated targets (foveation_filter_shader.h). Without
            // it, foveated swapchains are submitted as the driver upscaled their bins.
            auto filter = std::make_unique<office::FoveationFilter>();
            std::string filterError;
            if (filter->initialize(multiview, filterError))
                foveationFilter = std::move(filter);
            else
                LOG("FOVEATION_FILTER_UNAVAILABLE %s", filterError.c_str());
            fovea.filter = foveationFilter != nullptr;
            foveation = office::FoveationPolicy(fovea);
            LOG("FOVEATION_FILTER available=%d", fovea.filter);
        }
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
        // The first world targets use the page's settings from the last launch, or those a page
        // already sent, so a stored Off or render scale needs no second allocation. The page's
        // own settings replace them as usual when it differs.
        const auto startGraphics = host.startGraphics();
        auto initialTargets =
            worldTargetRequest(startGraphics.renderScale, startGraphics.foveation);
        bool created = replaceWorldTargets(initialTargets);
        if (!created && foveation.filterFailed(initialTargets.foveation)) {
            // Unfiltered: the foveated swapchains are submitted as the driver upscaled them.
            LOG("FOVEATION_FALLBACK %s", foveation.fallback());
            initialTargets = worldTargetRequest(startGraphics.renderScale, startGraphics.foveation);
            created = replaceWorldTargets(initialTargets);
        }
        if (!created &&
            initialTargets.size != worldTargetRequest(1.f, startGraphics.foveation).size) {
            // A stored size that cannot be allocated starts at the recommended size.
            initialTargets = worldTargetRequest(1.f, startGraphics.foveation);
            created = replaceWorldTargets(initialTargets);
        }
        if (!created && initialTargets.foveation.foveated()) {
            // Fall back to full-resolution swapchains without foveation support.
            foveation.swapchainFailed();
            LOG("FOVEATION_UNAVAILABLE %s", graphicsError.c_str());
            initialTargets = worldTargetRequest(1.f, startGraphics.foveation);
            created = replaceWorldTargets(initialTargets);
        }
        if (!created)
            throw std::runtime_error(graphicsError);
        targetChanges.reset(boundTargets);
        publishTargets(startGraphics.foveation);
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
            auto overlay = std::make_unique<office::FoveationOverlay>();
            std::string overlayError;
            if (overlay->initialize(multiview, overlayError))
                foveationOverlay = std::move(overlay);
            else
                LOG("FOVEATION_OVERLAY_UNAVAILABLE %s", overlayError.c_str());
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
        panelCutout = std::make_unique<office::PanelCutout>();
        panelCutout->initialize(multiview);
        cursor = std::make_unique<office::CursorSwapchain>();
        cursor->initialize(session, format);
    }

    // ---- WorldRenderer: bridge threads --------------------------------------------------------

    void enqueueScene(const std::string &packet) override {
        if (!sceneRenderer->enqueueJson(packet))
            LOG("SCENE_ERROR %s", sceneRenderer->lastError().c_str());
    }

    bool acceptsScene() override { return sceneRenderer->acceptsPackets(); }

    bool takeSceneReset() override { return sceneRenderer->takeResetRequest(); }

    // ---- WorldRenderer: frame loop ------------------------------------------------------------

    void sessionBegun() override {
        // Whether a profile applied before the session runs persists is not documented;
        // re-apply the same one on the first running frame.
        reapplyProfile = true;
    }

    void updateTargets(const office::GraphicsControls &graphics, double nowMs,
                       bool mayReplace) override {
        // Slider release/presets select an actual target size. Keep the old targets until
        // the selection settles. A foveation choice, Off included, is also new targets: the
        // runtime keeps the first profile a world swapchain receives (foveation.h), and Off
        // is a swapchain without foveation support.
        desiredTargets = worldTargetRequest(graphics.renderScale, graphics.foveation);
        if (mayReplace && targetChanges.observe(desiredTargets, nowMs)) {
            const bool replaced = replaceWorldTargets(desiredTargets);
            targetChanges.finish(replaced ? boundTargets : desiredTargets, replaced);
            if (replaced)
                publishTargets(graphics.foveation);
            else if (foveation.filterFailed(desiredTargets.foveation))
                // The next request is unfiltered, so it is tried after the usual settle time.
                LOG("FOVEATION_FALLBACK %s", foveation.fallback());
        }
        if (reapplyProfile) {
            // No world image is acquired here.
            reapplyProfile = false;
            for (int i = 0; foveationProfile && i < (multiview ? 1 : 2); ++i) {
                profileUpdateResult = applyProfile(renderEyes()[i].swapchain, foveationProfile);
                LOG("FOVEATION_PROFILE reapplied level=%s eyeTracked=%d update=%d",
                    office::foveationLevelName(boundTargets.foveation),
                    boundTargets.foveation.eyeTracked, profileUpdateResult);
            }
        }
        if (desiredTargets == boundTargets)
            graphicsError.clear();
    }

    bool render(const office::WorldFrame &frame,
                std::array<XrCompositionLayerProjectionView, 2> &projectionViews,
                std::array<XrCompositionLayerProjectionView, 2> &sharpProjectionViews) override {
        const auto &views = *frame.views;
        const auto &inputFrame = *frame.input;
        const auto &controls = *frame.controls;
        const XrPosef panelPose = frame.panelPose;
        const bool focused = frame.focused, poseValid = frame.poseValid, valid = frame.valid;
        // This frame's runtime-reported centres (NDC, left x/y then right x/y).
        float foveaCenters[4]{};
        bool foveaCenterValid = false;
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
        if (valid) {
            sceneRenderer->prepareFrame();
            // Held objects follow this frame's tracked grip, as the controller models do.
            office::AttachmentFrame attachmentFrame;
            attachmentFrame.focused = focused;
            attachmentFrame.poseValid = poseValid;
            attachmentFrame.shouldRender = frame.shouldRender;
            attachmentFrame.controlsActive = controls.active;
            attachmentFrame.nowNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        Clock::now().time_since_epoch())
                                        .count();
            attachmentFrame.receivedNs = controls.receivedNs;
            sceneRenderer->setControllerPoses(
                office::attachmentPoses(inputFrame, controls.rig, attachmentFrame));
        }
        // A held gun takes the controller's place in the hand: its model is not drawn there.
        const unsigned heldHands = valid ? sceneRenderer->attachedHands() : 0;
        inputRenderer->hideControllers(heldHands);
        // The workspace panel goes beneath the world layer, which then shows it through a
        // hole and keeps the player's controllers, rays and held gun in front of it.
        const bool panelUnder = frame.panelUnder;
        float cutViews[2][16]{}, cutCorners[4][3]{};
        if (panelUnder) {
            const auto corners = office::panelCutoutCorners(
                panelPose, office::kPanelWidth, office::kPanelHeight, office::kPanelCutoutInset);
            for (int c = 0; c < 4; c++) {
                cutCorners[c][0] = corners[c].x;
                cutCorners[c][1] = corners[c].y;
                cutCorners[c][2] = corners[c].z;
            }
        }
        office::SharpScreenPlan sharpPlan;
        bool sharp = valid && sharpScreensAvailable && controls.graphics.sharpScreens &&
                     controls.fade < .999f;
        if (sharp) {
            const auto &right = sharpEyes[multiview ? 0 : 1];
            const int widths[2]{sharpEyes[0].width, right.width},
                heights[2]{sharpEyes[0].height, right.height};
            sharp =
                sceneRenderer->planSharpScreens(worldViews, widths, heights, multiview, sharpPlan);
        }
        // Filtered targets: the world is drawn into the foveated swapchain, and the submitted
        // image is the filter pass's output. Otherwise both are the submitted image. While the
        // workspace panel is beneath the world layer the filter is left out (filterFrame) and
        // the foveated image is submitted as drawn, keeping the panel's hole in its alpha.
        const bool boundFiltered = boundTargets.foveation.filtered;
        const bool filtered = office::filterFrame(boundFiltered, panelUnder);
        const bool submitFoveated = boundFiltered && !filtered;
        if (valid)
            for (int pass = 0; pass < (multiview ? 1 : 2); pass++) {
                auto &eye = eyes[pass];
                auto &renderEye = boundFiltered ? foveatedEyes[pass] : eye;
                uint32_t imageIndex = 0, renderIndex = 0;
                auto acquire = office::structure<XrSwapchainImageAcquireInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO);
                auto imageWait =
                    office::structure<XrSwapchainImageWaitInfo>(XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO);
                imageWait.timeout = XR_INFINITE_DURATION;
                if (!submitFoveated) {
                    check(xrAcquireSwapchainImage(eye.swapchain, &acquire, &imageIndex),
                          "acquire eye");
                    check(xrWaitSwapchainImage(eye.swapchain, &imageWait), "wait eye");
                }
                renderIndex = imageIndex;
                if (boundFiltered) {
                    check(xrAcquireSwapchainImage(renderEye.swapchain, &acquire, &renderIndex),
                          "acquire foveated eye");
                    check(xrWaitSwapchainImage(renderEye.swapchain, &imageWait),
                          "wait foveated eye");
                }
                const auto rect = office::renderRect(eye.width, eye.height, 1.f);
                if (boundTargets.foveation.eyeTracked && foveationProfile) {
                    // "xrUpdateSwapchainFB should be called right before the
                    // xrGetFoveationEyeTrackedStateMETA function in order to (1) request a
                    // foveation pattern update by the runtime" (XR_META_foveation_eye_tracked).
                    // Each frame, after acquire and before drawing, as Godot does
                    // (_update_profile_rt then xrGetFoveationEyeTrackedStateMETA). Like Godot,
                    // a failed update or query is tried again on the next frame.
                    const auto updated = applyProfile(renderEye.swapchain, foveationProfile);
                    if (pass == 0) {
                        auto state = office::structure<XrFoveationEyeTrackedStateMETA>(
                            XR_TYPE_FOVEATION_EYE_TRACKED_STATE_META);
                        const auto queried = getFoveationState(session, &state);
                        // Not valid "if the eye tracker is obscured, the camera has dirt, or
                        // eye lid is closed" (registry). The app never moves the fovea itself.
                        foveaCenterValid =
                            XR_SUCCEEDED(queried) &&
                            (state.flags & XR_FOVEATION_EYE_TRACKED_STATE_VALID_BIT_META);
                        foveationSamples.sample(updated, queried, foveaCenterValid,
                                                state.foveationCenter);
                        if (foveaCenterValid)
                            for (int i = 0; i < 2; ++i) {
                                foveaCenters[i * 2] = state.foveationCenter[i].x;
                                foveaCenters[i * 2 + 1] = state.foveationCenter[i].y;
                            }
                        if (!eyeResultsLogged || updated != eyeUpdateLogged ||
                            queried != eyeStateLogged) {
                            eyeResultsLogged = true;
                            eyeUpdateLogged = updated;
                            eyeStateLogged = queried;
                            LOG("FOVEATION_EYE_STATE update=%d state=%d valid=%d", updated, queried,
                                foveaCenterValid);
                        }
                        // Only an unsupported state drops eye tracking; the targets are then
                        // recreated with the fixed level.
                        if (foveation.eyeTrackedState(queried))
                            LOG("FOVEATION_FALLBACK %s state=%d", foveation.fallback(), queried);
                    }
                }
                glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
                attachWorldImage(renderEye, renderIndex, depthTexture);
                auto status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
                if (status != GL_FRAMEBUFFER_COMPLETE)
                    throw std::runtime_error("Projection framebuffer incomplete: " +
                                             std::to_string(status));
                glViewport(rect.x, rect.y, rect.width, rect.height);
                auto drawScene = [&](office::SceneDrawSet set) {
                    if (multiview)
                        sceneRenderer->renderStereo(worldViews, rect.height, {}, set);
                    else
                        sceneRenderer->render(worldViews[pass], rect.height, set);
                };
                if (panelUnder) {
                    // The world, the panel's hole over it (whatever was nearer), then what
                    // the player holds and the controllers, depth-tested against the panel.
                    std::copy(localViews[pass].begin(), localViews[pass].end(), cutViews[0]);
                    const auto &other = localViews[multiview ? 1 : pass];
                    std::copy(other.begin(), other.end(), cutViews[1]);
                    drawScene(office::SceneDrawSet::World);
                    panelCutout->punch(cutViews, cutCorners);
                    drawScene(office::SceneDrawSet::Attached);
                } else {
                    drawScene(office::SceneDrawSet::All);
                }
                inputRenderer->render(localViews[pass], localViews[multiview ? 1 : pass]);
                // The screen layer composites over the world layer: no screen over the panel.
                if (panelUnder && sharp)
                    panelCutout->seal(cutViews, cutCorners);
                inputRenderer->renderFade(controls.fade);
                // Diagnostic: drawn last into the foveated target, so its fragments run at
                // the runtime's actual density for this frame.
                if (controls.graphics.foveationDebug && foveationOverlay)
                    foveationOverlay->render(pass, eye.width, eye.height, foveaCenters,
                                             foveaMarker(foveaCenterValid));
                // Last in the foveated pass: each invocation's neighbour steps, for the filter.
                if (filtered)
                    foveationFilter->markDensity();
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
                if (filtered) {
                    // The submitted image: every pixel written, so its old contents are not
                    // loaded. Full-density pixels are copied; reduced ones are filtered over
                    // their own block width (foveation_filter_shader.h).
                    glBindFramebuffer(GL_FRAMEBUFFER, filterFramebuffer);
                    attachFilteredImage(eye, imageIndex);
                    status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
                    if (status != GL_FRAMEBUFFER_COMPLETE)
                        throw std::runtime_error("Filtered framebuffer incomplete: " +
                                                 std::to_string(status));
                    const GLenum colour = GL_COLOR_ATTACHMENT0;
                    glInvalidateFramebuffer(GL_FRAMEBUFFER, 1, &colour);
                    glViewport(rect.x, rect.y, rect.width, rect.height);
                    foveationFilter->resolve(renderEye.images[renderIndex].image);
                    glBindFramebuffer(GL_FRAMEBUFFER, 0);
                }
                if (renderIndex < imageUses.size() && imageUses[renderIndex] < 2 &&
                    ++imageUses[renderIndex] == 2) {
                    // Read-only: did the runtime enable QCOM foveation on this GLES image?
                    // GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM and _MIN_PIXEL_DENSITY_QCOM are
                    // GetTexParameter queries (QCOM_texture_foveated, Table 21.10); an image
                    // of a swapchain without foveation support reads 0.
                    const GLenum target = multiview ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
                    glActiveTexture(GL_TEXTURE0);
                    glBindTexture(target, renderEye.images[renderIndex].image);
                    glGetTexParameteriv(target, GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM,
                                        &textureBits);
                    glGetTexParameterfv(target, GL_TEXTURE_FOVEATED_MIN_PIXEL_DENSITY_QCOM,
                                        &textureMinDensity);
                    glGetTexParameteriv(target, GL_TEXTURE_FOVEATED_NUM_FOCAL_POINTS_QUERY_QCOM,
                                        &textureFocalPoints);
                    glBindTexture(target, 0);
                    const auto probeError = glGetError();
                    LOG("FOVEATION_TEXTURE image=%u level=%s eyeTracked=%d filtered=%d "
                        "bits=%d minDensity=%.3f focalPoints=%d gl_error=%x",
                        renderIndex, office::foveationLevelName(boundTargets.foveation),
                        boundTargets.foveation.eyeTracked, boundFiltered, textureBits,
                        textureMinDensity, textureFocalPoints, probeError);
                    ++imagesProbed;
                    if (probeError == GL_NO_ERROR && textureBits == 0)
                        ++imagesUnfoveated;
                    // No OpenXR text says a runtime foveates a swapchain that is never
                    // submitted. If none of them was, the next targets submit it directly.
                    if (boundFiltered && imagesProbed == imageUses.size() &&
                        imagesUnfoveated == imagesProbed &&
                        foveation.filterFailed(boundTargets.foveation,
                                               "filtered swapchain not foveated"))
                        LOG("FOVEATION_FALLBACK %s", foveation.fallback());
                }
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
                    check(xrAcquireSwapchainImage(screenEye.swapchain, &acquire, &screenImageIndex),
                          "acquire sharp screen");
                    check(xrWaitSwapchainImage(screenEye.swapchain, &imageWait),
                          "wait sharp screen");
                    glBindFramebuffer(GL_FRAMEBUFFER, sharpFramebuffer);
                    if (multiview)
                        attachMultiview(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                        screenEye.images[screenImageIndex].image, 0, 0, 2);
                    else
                        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                                               screenEye.images[screenImageIndex].image, 0);
                    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
                        throw std::runtime_error("Sharp screen framebuffer incomplete");
                    glViewport(0, 0, screenEye.width, screenEye.height);
                    // Clears and draws only the planned region; the rest is never presented.
                    sceneRenderer->renderSharpScreens(sharpPlan, pass, screenDepth, controls.fade);
                    glBindFramebuffer(GL_FRAMEBUFFER, 0);
                    auto screenRelease = office::structure<XrSwapchainImageReleaseInfo>(
                        XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                    check(xrReleaseSwapchainImage(screenEye.swapchain, &screenRelease),
                          "release sharp screen");
                }
                glFlush();
                auto release = office::structure<XrSwapchainImageReleaseInfo>(
                    XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO);
                if (boundFiltered)
                    check(xrReleaseSwapchainImage(renderEye.swapchain, &release),
                          "release foveated eye");
                if (!submitFoveated)
                    check(xrReleaseSwapchainImage(eye.swapchain, &release), "release eye");
            }
        for (int i = 0; i < 2; i++) {
            auto &eye = (submitFoveated ? foveatedEyes : eyes)[multiview ? 0 : i];
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
        lastSharp = sharp;
        lastSharpPlan = sharpPlan;
        return sharp;
    }

    XrCompositionLayerQuad cursorLayer(XrSpace space, XrPosef pose) const override {
        return cursor->layer(space, pose);
    }

    unsigned attachedHands() const override { return sceneRenderer->attachedHands(); }

    size_t attachedBounds(float (*out)[4], size_t max) const override {
        return sceneRenderer->attachedBounds(out, max);
    }

    // ---- WorldRenderer: metrics ---------------------------------------------------------------

    void addFrameMetrics(nlohmann::json &frameMetrics) override {
        frameMetrics["sharpScreens"] = lastSharp;
        frameMetrics["worldRecommendedWidth"] = worldLimits[0].recommended.width;
        frameMetrics["worldRecommendedHeight"] = worldLimits[0].recommended.height;
        frameMetrics["worldMaxWidth"] = worldLimits[0].maximum.width;
        frameMetrics["worldMaxHeight"] = worldLimits[0].maximum.height;
        frameMetrics["worldWidth"] = eyes[0].width;
        frameMetrics["worldHeight"] = eyes[0].height;
        frameMetrics["maxRenderScale"] = office::maximumRenderScale(worldLimits[0]);
        // The UI's availability and the bound mode. The details have their own log line:
        // with them, this one exceeded Android's 1024-byte log record and was cut off.
        frameMetrics["foveationSupported"] = foveation.swapchainFoveation();
        frameMetrics["foveationEnabled"] = boundTargets.foveation.foveated();
        frameMetrics["foveationLevel"] = office::foveationLevelName(boundTargets.foveation);
        frameMetrics["graphicsError"] = graphicsError;
        if (lastSharp) {
            frameMetrics["sharpWidth"] = sharpEyes[0].width;
            frameMetrics["sharpHeight"] = sharpEyes[0].height;
            // This frame's presented crop of each eye (x, y, width, height).
            frameMetrics["sharpCrop"] = {
                std::vector<int>(lastSharpPlan.viewRect[0], lastSharpPlan.viewRect[0] + 4),
                std::vector<int>(lastSharpPlan.viewRect[1], lastSharpPlan.viewRect[1] + 4)};
        }
    }

    nlohmann::json foveationMetrics(const office::GraphicsControls &graphics) override {
        const auto fovea = foveationMetrics(graphics, desiredTargets);
        foveationSamples.reset();
        return fovea;
    }

    office::SceneStats sceneStats() const override { return sceneRenderer->stats(); }

    std::string frameMetricsSuffix() override {
        char text[32];
        std::snprintf(text, sizeof text, " gl_error=%x", glGetError());
        return text;
    }

    // ---- WorldRenderer: teardown --------------------------------------------------------------

    void finishGpuWork() override {
        // Complete image use before any teardown that destroys a runtime swapchain,
        // including the cursor. The last frame's glFlush only submitted those commands.
        if (context != EGL_NO_CONTEXT)
            glFinish();
        inputRenderer.reset();
        foveationOverlay.reset();
        foveationFilter.reset();
        panelCutout.reset();
        sceneRenderer.reset();
#ifndef NDEBUG
        depthProbe.reset();
#endif
        cursor.reset();
    }

    void destroyProfile() override {
        // A profile is a child of the session. "The application is responsible for ensuring
        // that it has no calls using profile in progress when the foveation profile is
        // destroyed" (XR_FB_foveation, xrDestroyFoveationProfileFB).
        if (foveationProfile && destroyFoveationProfile)
            destroyFoveationProfile(foveationProfile);
        foveationProfile = XR_NULL_HANDLE;
    }

    void destroyTargets() override {
        for (auto &eye : eyes)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        for (auto &eye : foveatedEyes)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        for (auto &eye : sharpEyes)
            if (eye.swapchain)
                xrDestroySwapchain(eye.swapchain);
        if (sharpFramebuffer)
            glDeleteFramebuffers(1, &sharpFramebuffer);
        if (filterFramebuffer)
            glDeleteFramebuffers(1, &filterFramebuffer);
        if (framebuffer)
            glDeleteFramebuffers(1, &framebuffer);
        if (depthTexture)
            glDeleteTextures(1, &depthTexture);
        for (auto *set : {&eyes, &foveatedEyes, &sharpEyes})
            for (auto &eye : *set)
                eye.swapchain = XR_NULL_HANDLE;
        sharpFramebuffer = filterFramebuffer = framebuffer = depthTexture = 0;
    }
};
} // namespace

std::unique_ptr<office::WorldRenderer> office::makeGlesWorld(const office::WorldHost &host) {
    return std::make_unique<GlesWorld>(host);
}
