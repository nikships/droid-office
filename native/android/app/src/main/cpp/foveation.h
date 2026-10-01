#pragma once
// Runtime-owned fixed foveated rendering for the OpenGL ES world renderer. The OpenXR runtime
// configures GL_QCOM_texture_foveated on the world swapchain images; the app only chooses a level
// profile and applies it. The app never writes QCOM texture state or focal points.
//
// Extensions (OpenXR 1.1 registry, https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html):
//   XR_FB_foveation (depends on XR_FB_swapchain_update_state) and XR_FB_foveation_configuration
//   (levels). Working GLES references that use exactly this and no QCOM call: Meta OpenXR SDK
//   XrCompositor_NativeActivity.c (ovrRenderer_SetFoveation) and Godot's
//   modules/openxr/extensions/openxr_fb_foveation_extension.cpp (Compatibility renderer).
//
// Fixed only: Android XR documents eye-tracked foveated rendering for Vulkan, and its OpenGL ES
// option, the Unity "Foveation (Legacy)" feature, enables only these extensions
// (https://developer.android.com/develop/xr/unity, "Foveation (Legacy) ... also supports ...
// OpenGL ES"). On Galaxy XR, xrGetFoveationEyeTrackedStateMETA failed on every frame of a GLES
// session and the runtime logged "Using static model" for the eye-tracked profile, so the GLES
// renderer neither enables XR_META_foveation_eye_tracked nor queries it. Eye-tracked foveation
// needs the Vulkan world renderer.
#include "graphics_controls.h"
#include <cstdint>
#include <openxr/openxr.h>
#include <vector>

namespace office {
/** What the runtime and GL driver offer; filled once at startup. */
struct FoveationSupport {
    bool fbFoveation = false;   // XR_FB_foveation enabled
    bool configuration = false; // XR_FB_foveation_configuration enabled
    bool updateState = false;   // XR_FB_swapchain_update_state enabled
    // XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB requires OpenGL and QCOM_texture_foveated
    // (registry comment on XrSwapchainCreateFoveationFlagBitsFB).
    bool qcomTexture = false;
    // The filtered reconstruction's programs compiled (foveation_filter.h).
    bool filter = false;
};

/** Levels need the configuration extension; the profile is applied with xrUpdateSwapchainFB. */
inline bool runtimeFoveation(const FoveationSupport &s) {
    return s.fbFoveation && s.configuration && s.updateState && s.qcomTexture;
}

/**
 * Whether a pass of filtered targets goes through the filter pass, or submits the foveated image
 * as drawn.
 *
 * imageFoveated: the image the world was drawn into reads FOVEATION_ENABLE_BIT_QCOM. The Galaxy XR
 * runtime applies a swapchain's foveation profile to its GL images when that swapchain is
 * submitted in a projection layer, not when the profile is applied (FoveationPriming), so a new
 * foveated set is submitted directly until its images are foveated. Those images are drawn at full
 * density, so the frame looks the same either way.
 *
 * panelUnderlay: while the workspace panel is composited beneath the world layer
 * (panel_cutout.h), the world image's alpha is the hole that shows the panel, but the filter keeps
 * its density codes in that alpha and submits opaque pixels, which would cover the panel. Such
 * frames submit the foveated image as drawn, as unfiltered targets do: the driver's blocky
 * periphery for as long as the workspace is open, at the same GPU cost.
 */
inline bool filterFrame(bool filteredTargets, bool panelUnderlay, bool imageFoveated) {
    return filteredTargets && !panelUnderlay && imageFoveated;
}

/**
 * The runtime's Low, Medium and High profiles. Internal enum names retain the old wire mapping.
 * HIGH is "lower periphery visual fidelity, higher performance" and LOW "higher periphery visual
 * fidelity, lower performance" (registry enum comments). Off creates unfoveated world targets.
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
        return "low";
    case FoveationQuality::Performance:
        return "high";
    case FoveationQuality::Off:
        return "off";
    case FoveationQuality::Balanced:
    default:
        return "medium";
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
 * Chooses the world targets' foveation for a setting and degrades one step at a time when
 * something fails: filtered -> unfiltered (the foveated swapchains submitted as the driver
 * upscaled them) -> swapchains without foveation support (full resolution everywhere). Each step
 * is kept for the rest of the session.
 *
 * A foveated level is filtered whenever the reconstruction is available: the world renders into
 * runtime-foveated swapchains, and the submitted swapchains, created without foveation support,
 * receive a filtered copy (foveation_filter_shader.h). Unfiltered, the runtime's scaled bins are
 * submitted as the driver upscaled them, in hard blocks.
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
    bool filterAvailable() const { return support.filter && !filterRejected; }

    TargetFoveation desired(FoveationQuality quality) const {
        TargetFoveation foveation;
        if (!swapchainFoveation() || quality == FoveationQuality::Off)
            return foveation;
        foveation.level = foveationLevel(quality);
        foveation.filtered = filterAvailable();
        return foveation;
    }

    /**
     * Filtered targets could not be created (their second set of swapchains, or validation), or
     * the runtime never foveated their foveated swapchains, even submitted. Returns true when
     * unfiltered targets are worth trying instead.
     */
    bool filterFailed(const TargetFoveation &foveation,
                      const char *why = "filtered targets rejected") {
        if (!foveation.filtered || filterRejected)
            return false;
        filterRejected = true;
        if (!*reason)
            reason = why;
        return true;
    }

    /**
     * The runtime refused to create or apply a level profile on new world swapchains: the targets
     * must be created without foveation support.
     */
    void rejected(const TargetFoveation &foveation) {
        if (!foveation.foveated())
            return;
        if (!swapchainRejected)
            reason = "foveation profile rejected";
        swapchainRejected = true;
    }

    /** Foveated world swapchains could not be created or validated. */
    void swapchainFailed() {
        if (!swapchainRejected)
            reason = "foveated swapchain rejected";
        swapchainRejected = true;
    }

    /** Why the applied mode is below the requested one, or "". */
    const char *fallback() const { return reason; }

  private:
    FoveationSupport support;
    bool swapchainRejected = false, filterRejected = false;
    const char *reason = "";
};

/**
 * Which images of a filtered target's foveated swapchains the runtime has foveated.
 *
 * Applying a profile with xrUpdateSwapchainFB only stores it with a Galaxy XR GLES swapchain. The
 * runtime writes GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM and the focal points of every image of a
 * swapchain when that swapchain is submitted in a projection layer (libopenxr_android.so: the
 * projection layer registers its swapchains, and the GL client compositor's layer commit calls
 * client_gl_eglimage_apply_foveation for each), so a foveated set that is never submitted is never
 * foveated (2026-10-01 headset run: FEATURE_BITS 0 on every image). Meta's GLES sample submits its
 * foveated swapchain the same way. A filtered target's foveated set is therefore submitted
 * directly, without the filter, while the image being drawn reads no FOVEATION_ENABLE_BIT_QCOM;
 * one submission foveates all its images. The state is per texture object and "once foveation has
 * been enabled for a texture, it cannot be disabled" (QCOM_texture_foveated), so an image read as
 * foveated stays foveated and is not read again.
 */
class FoveationPriming {
  public:
    /** Direct submissions of unfoveated images after which the set is taken as never foveated. */
    static constexpr uint32_t kGiveUpFrames = 8;

    /** New targets: `passes` foveated swapchains of `images` images each, none foveated yet. */
    void reset(int passes, size_t images) {
        foveatedImages.assign(size_t(passes > 0 ? passes : 0) * images, 0);
        perPass = images;
        directFrames = 0;
        reported = false;
    }

    /** The image is known to be foveated, so its bits need not be read. */
    bool known(int pass, uint32_t image) const {
        const size_t i = index(pass, image);
        return i < foveatedImages.size() && foveatedImages[i];
    }

    /**
     * The image's GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM, read while it is acquired. Returns
     * whether it is foveated (FOVEATION_ENABLE_BIT_QCOM, 0x1).
     */
    bool observe(int pass, uint32_t image, int featureBits) {
        const size_t i = index(pass, image);
        const bool foveated = (featureBits & 0x1) != 0;
        if (foveated && i < foveatedImages.size())
            foveatedImages[i] = 1;
        return foveated;
    }

    /**
     * A pass submitted its unfoveated image directly. Returns true once, after kGiveUpFrames of
     * them: the runtime does not foveate this set even submitted.
     */
    bool submittedUnfoveated() {
        ++directFrames;
        if (directFrames < kGiveUpFrames || reported)
            return false;
        reported = true;
        return true;
    }

    /** Every image of every foveated swapchain is foveated. */
    bool complete() const {
        for (auto known : foveatedImages)
            if (!known)
                return false;
        return !foveatedImages.empty();
    }

    uint32_t primingFrames() const { return directFrames; }

  private:
    size_t index(int pass, uint32_t image) const {
        if (pass < 0 || image >= perPass)
            return foveatedImages.size();
        return size_t(pass) * perPass + image;
    }
    std::vector<uint8_t> foveatedImages;
    size_t perPass = 0;
    uint32_t directFrames = 0;
    bool reported = false;
};

/** How each world pass was submitted over one metrics window. */
struct FoveationFrames {
    uint32_t filtered = 0; // through the filter pass
    uint32_t priming = 0;  // the foveated image directly, while it was not foveated yet
    uint32_t underlay = 0; // the foveated image directly, for the workspace panel beneath it
    void reset() { filtered = priming = underlay = 0; }
};
} // namespace office
