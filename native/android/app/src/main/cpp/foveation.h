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
 * same order. Off is handled by the empty profile, not by a level.
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

/** One runtime profile request. */
struct FoveationProfileSpec {
    // False when the world swapchains have no foveation support: nothing is applied.
    bool apply = false;
    // XrFoveationProfileCreateInfoFB with nothing in its next chain: "a foveation profile that
    // will apply no foveation to any area of the swapchain" (XR_FB_foveation, a runtime must).
    bool empty = true;
    XrFoveationLevelFB level = XR_FOVEATION_LEVEL_NONE_FB;
    // XrFoveationEyeTrackedProfileCreateInfoMETA chained to the level struct.
    bool eyeTracked = false;
    bool operator==(const FoveationProfileSpec &o) const {
        return apply == o.apply && empty == o.empty && level == o.level &&
               eyeTracked == o.eyeTracked;
    }
    bool operator!=(const FoveationProfileSpec &o) const { return !(*this == o); }
};

/** "unfoveated" (no swapchain support), "none" (empty profile), or the level. */
inline const char *foveationLevelName(const FoveationProfileSpec &spec) {
    if (!spec.apply)
        return "unfoveated";
    if (spec.empty)
        return "none";
    switch (spec.level) {
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
 * Chooses the profile for a setting and degrades one step at a time when the runtime rejects
 * something: eye-tracked -> fixed level -> empty profile -> swapchains without foveation (full
 * resolution everywhere). Each step is kept for the rest of the session.
 */
class FoveationPolicy {
  public:
    static constexpr int kStateFailureLimit = 30; // about a third of a second at 90 Hz

    explicit FoveationPolicy(FoveationSupport s = {}) : support(s) {}
    const FoveationSupport &capabilities() const { return support; }

    /** World swapchains carry XrSwapchainCreateInfoFoveationFB{SCALED_BIN}. */
    bool swapchainFoveation() const { return runtimeFoveation(support) && !swapchainRejected; }
    bool eyeTrackedAvailable() const { return eyeTrackedFoveation(support) && !eyeTrackedRejected; }

    FoveationProfileSpec desired(FoveationQuality quality) const {
        FoveationProfileSpec spec;
        spec.apply = swapchainFoveation();
        if (!spec.apply || quality == FoveationQuality::Off || levelsRejected)
            return spec;
        spec.empty = false;
        spec.level = foveationLevel(quality);
        spec.eyeTracked = eyeTrackedAvailable();
        return spec;
    }

    /** The runtime refused to create or apply spec. Returns false when nothing is left to try. */
    bool rejected(const FoveationProfileSpec &spec) {
        if (!spec.apply)
            return false;
        if (spec.eyeTracked) {
            eyeTrackedRejected = true;
            reason = "eye-tracked profile rejected";
        } else if (!spec.empty) {
            levelsRejected = true;
            reason = "foveation level rejected";
        } else {
            swapchainRejected = true;
            reason = "empty profile rejected";
        }
        return swapchainFoveation();
    }

    /** Foveated world swapchains could not be created or validated. */
    void swapchainFailed() {
        if (!swapchainRejected)
            reason = "foveated swapchain rejected";
        swapchainRejected = true;
    }

    /**
     * One eye-tracked frame: the per-frame xrUpdateSwapchainFB and
     * xrGetFoveationEyeTrackedStateMETA results. Returns true when eye tracking was dropped, so
     * the caller re-applies a fixed profile. A state without the VALID bit (closed eyes, an
     * obscured tracker) is not an API failure and keeps the eye-tracked profile.
     */
    bool eyeTrackedFrame(XrResult update, XrResult state) {
        if (eyeTrackedRejected)
            return false;
        if (XR_FAILED(update)) {
            eyeTrackedRejected = true;
            reason = "eye-tracked update failed";
            return true;
        }
        // XR_ERROR_FEATURE_UNSUPPORTED is a listed result of xrGetFoveationEyeTrackedStateMETA.
        if (state == XR_ERROR_FEATURE_UNSUPPORTED) {
            eyeTrackedRejected = true;
            reason = "eye-tracked state unsupported";
            return true;
        }
        stateFailures = XR_FAILED(state) ? stateFailures + 1 : 0;
        if (stateFailures >= kStateFailureLimit) {
            eyeTrackedRejected = true;
            reason = "eye-tracked state failing";
            return true;
        }
        return false;
    }

    /** Why the applied mode is below the requested one, or "". */
    const char *fallback() const { return reason; }

  private:
    FoveationSupport support;
    bool swapchainRejected = false, levelsRejected = false, eyeTrackedRejected = false;
    int stateFailures = 0;
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
