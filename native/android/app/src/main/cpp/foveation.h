#pragma once
// Runtime-owned foveated rendering. The OpenXR runtime configures GL_QCOM_texture_foveated on the
// world swapchain images; the app only chooses a profile and applies it. The app never writes
// QCOM texture state or focal points.
//
// Extensions (OpenXR 1.1 registry, https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html):
//   XR_FB_foveation (depends on XR_FB_swapchain_update_state), XR_FB_foveation_configuration
//   (levels), XR_META_foveation_eye_tracked (depends on both FB foveation extensions).
// Working GLES references that use exactly this and no QCOM call: Meta OpenXR SDK
// XrCompositor_NativeActivity.c (ovrRenderer_SetFoveation) and Godot's
// modules/openxr/extensions/openxr_fb_foveation_extension.cpp (Compatibility renderer).
#include "graphics_controls.h"
#include <array>
#include <cstdint>
#include <openxr/openxr.h>

namespace office {
/** What the runtime, system and GL driver offer; filled once at startup. */
struct FoveationSupport {
    bool fbFoveation = false;   // XR_FB_foveation enabled
    bool configuration = false; // XR_FB_foveation_configuration enabled
    bool updateState = false;   // XR_FB_swapchain_update_state enabled
    // XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB requires OpenGL and QCOM_texture_foveated
    // (registry comment on XrSwapchainCreateFoveationFlagBitsFB).
    bool qcomTexture = false;
    bool metaEyeTracked = false;   // XR_META_foveation_eye_tracked enabled
    bool systemEyeTracked = false; // XrSystemFoveationEyeTrackedPropertiesMETA
    // Android XR lists EYE_TRACKING_FINE as the permission for XR_META_foveation_eye_tracked:
    // https://developer.android.com/develop/xr/openxr/extensions
    bool eyePermission = false;
    // XR_EXT_eye_gaze_interaction enabled and bound. Not a spec dependency; logged because
    // Godot found Galaxy XR needs it for eye-tracked foveation (godotengine/godot#113778).
    bool eyeGaze = false;
};

/** Levels need the configuration extension; the profile is applied with xrUpdateSwapchainFB. */
inline bool runtimeFoveation(const FoveationSupport &s) {
    return s.fbFoveation && s.configuration && s.updateState && s.qcomTexture;
}

inline bool eyeTrackedFoveation(const FoveationSupport &s) {
    return runtimeFoveation(s) && s.metaEyeTracked && s.systemEyeTracked && s.eyePermission;
}

/**
 * The app's mapping of its quality names to XrFoveationLevelFB, an app policy rather than a
 * documented table. HIGH is "lower periphery visual fidelity, higher performance" and LOW
 * "higher periphery visual fidelity, lower performance" (registry enum comments). Godot uses the
 * same order. Off is not a profile: its world swapchains are created without foveation support.
 */
inline XrFoveationLevelFB foveationLevel(FoveationQuality quality) {
    switch (quality) {
    case FoveationQuality::Clarity:
        return XR_FOVEATION_LEVEL_LOW_FB;
    case FoveationQuality::Performance:
        return XR_FOVEATION_LEVEL_HIGH_FB;
    case FoveationQuality::Off:
        return XR_FOVEATION_LEVEL_NONE_FB;
    case FoveationQuality::Balanced:
    default:
        return XR_FOVEATION_LEVEL_MEDIUM_FB;
    }
}

inline const char *foveationQualityName(FoveationQuality quality) {
    switch (quality) {
    case FoveationQuality::Clarity:
        return "clarity";
    case FoveationQuality::Performance:
        return "performance";
    case FoveationQuality::Off:
        return "off";
    case FoveationQuality::Balanced:
    default:
        return "balanced";
    }
}

/** "none" for world targets without foveation support, otherwise the bound runtime level. */
inline const char *foveationLevelName(const TargetFoveation &foveation) {
    switch (foveation.level) {
    case XR_FOVEATION_LEVEL_LOW_FB:
        return "low";
    case XR_FOVEATION_LEVEL_MEDIUM_FB:
        return "medium";
    case XR_FOVEATION_LEVEL_HIGH_FB:
        return "high";
    default:
        return "none";
    }
}

/**
 * Chooses the world targets' foveation for a setting and degrades one step at a time when the
 * runtime rejects something: eye-tracked -> the same level fixed -> swapchains without foveation
 * support (full resolution everywhere). Each step is kept for the rest of the session.
 *
 * Every change of the result is a new set of world swapchains with that profile applied first,
 * as Meta (ovrRenderer_Create, then ovrRenderer_SetFoveation) and Godot
 * (on_main_swapchains_created -> update_profile) apply theirs. A swapchain created without
 * XrSwapchainCreateInfoFoveationFB has no foveation support (XR_FB_foveation), which is how Off
 * renders full density: GL_QCOM_texture_foveated says foveation "cannot be disabled" on a texture
 * once enabled, and on Galaxy XR neither the empty profile nor another level changed a world
 * swapchain that had already received a profile (headset capture, 2026-10-01).
 */
class FoveationPolicy {
  public:
    explicit FoveationPolicy(FoveationSupport s = {}) : support(s) {}
    const FoveationSupport &capabilities() const { return support; }

    /** World swapchains may carry XrSwapchainCreateInfoFoveationFB{SCALED_BIN}. */
    bool swapchainFoveation() const { return runtimeFoveation(support) && !swapchainRejected; }
    bool eyeTrackedAvailable() const { return eyeTrackedFoveation(support) && !eyeTrackedRejected; }

    TargetFoveation desired(FoveationQuality quality) const {
        TargetFoveation foveation;
        if (!swapchainFoveation() || quality == FoveationQuality::Off)
            return foveation;
        foveation.level = foveationLevel(quality);
        foveation.eyeTracked = eyeTrackedAvailable();
        return foveation;
    }

    /**
     * The runtime refused to create or apply foveation's profile on new world swapchains. Returns
     * true when the same level without eye tracking is still worth applying to them; false when
     * the targets must be created without foveation support.
     */
    bool rejected(const TargetFoveation &foveation) {
        if (!foveation.foveated())
            return false;
        if (foveation.eyeTracked) {
            eyeTrackedRejected = true;
            reason = "eye-tracked profile rejected";
            return true;
        }
        if (!swapchainRejected)
            reason = "foveation profile rejected";
        swapchainRejected = true;
        return false;
    }

    /** Foveated world swapchains could not be created or validated. */
    void swapchainFailed() {
        if (!swapchainRejected)
            reason = "foveated swapchain rejected";
        swapchainRejected = true;
    }

    /**
     * One eye-tracked frame's xrGetFoveationEyeTrackedStateMETA result. Returns true when eye
     * tracking is dropped, so the caller creates targets with the fixed level. Only
     * XR_ERROR_FEATURE_UNSUPPORTED, a listed result of that query, drops it. Any other failure,
     * like a state without the VALID bit (closed eyes, an obscured tracker, nobody wearing the
     * headset), keeps the eye-tracked profile and is queried again next frame, as Godot's
     * get_fragment_density_offsets logs a failed query and retries on the next frame.
     */
    bool eyeTrackedState(XrResult state) {
        if (!eyeTrackedAvailable() || state != XR_ERROR_FEATURE_UNSUPPORTED)
            return false;
        eyeTrackedRejected = true;
        reason = "eye-tracked state unsupported";
        return true;
    }

    /** Why the applied mode is below the requested one, or "". */
    const char *fallback() const { return reason; }

  private:
    FoveationSupport support;
    bool swapchainRejected = false, eyeTrackedRejected = false;
    const char *reason = "";
};

/** Eye-tracked foveation state over one metrics window. */
struct FoveationSamples {
    uint32_t frames = 0, valid = 0, invalid = 0, failed = 0;
    XrResult update = XR_SUCCESS, state = XR_SUCCESS;
    bool centerValid = false;
    std::array<XrVector2f, 2> center{};

    void sample(XrResult updateResult, XrResult stateResult, bool isValid,
                const XrVector2f *centers) {
        ++frames;
        update = updateResult;
        state = stateResult;
        if (XR_FAILED(updateResult) || XR_FAILED(stateResult)) {
            ++failed;
            centerValid = false;
            return;
        }
        centerValid = isValid && centers;
        if (centerValid) {
            ++valid;
            center = {centers[0], centers[1]};
        } else
            ++invalid;
    }
    void reset() {
        frames = valid = invalid = failed = 0;
        centerValid = false;
    }
};
} // namespace office
