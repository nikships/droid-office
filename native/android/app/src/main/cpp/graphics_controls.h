#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace office {
enum class FoveationQuality { Balanced, Clarity, Performance, Off };
struct GraphicsControls {
    float renderScale = 1.f;
    FoveationQuality foveation = FoveationQuality::Balanced;
    bool sharpScreens = true;
    // Diagnostic: tint the world by its measured shading density (foveation_overlay.h).
    bool foveationDebug = false;
};
struct RenderRect {
    int x = 0, y = 0, width = 0, height = 0;
};
struct RenderSize {
    int width = 0, height = 0;
    bool operator==(const RenderSize &other) const {
        return width == other.width && height == other.height;
    }
    bool operator!=(const RenderSize &other) const { return !(*this == other); }
};
struct ResolutionLimits {
    RenderSize recommended, maximum;
};
/** Uniform eye-resolution multiplier, bounded by both runtime axes and the UI's 200% ceiling. */
inline float maximumRenderScale(const ResolutionLimits &limits) {
    if (limits.recommended.width < 2 || limits.recommended.height < 2 || limits.maximum.width < 2 ||
        limits.maximum.height < 2)
        return 1.f;
    return std::min({2.f, float(limits.maximum.width) / limits.recommended.width,
                     float(limits.maximum.height) / limits.recommended.height});
}
/** 100% retains the existing recommended size; higher values really allocate more eye pixels. */
inline RenderSize renderSize(const ResolutionLimits &limits, float scale) {
    scale = std::isfinite(scale) ? std::clamp(scale, .75f, 2.f) : 1.f;
    scale = std::min(scale, maximumRenderScale(limits));
    const auto dimension = [scale](int recommended, int maximum) {
        maximum = std::max(2, maximum & ~1);
        const auto pixels = static_cast<int>(std::floor(std::max(2, recommended) * scale + .001f));
        return std::clamp(pixels & ~1, 2, maximum);
    };
    return {dimension(limits.recommended.width, limits.maximum.width),
            dimension(limits.recommended.height, limits.maximum.height)};
}
/**
 * The runtime foveation a set of world swapchains is created with (foveation.h). level is an
 * XrFoveationLevelFB value: 0 (NONE) creates them without XrSwapchainCreateInfoFoveationFB, so
 * they have no foveation support at all; LOW, MEDIUM or HIGH creates them with it and applies that
 * level's profile, with the eye-tracked struct when eyeTracked, as their first profile. On Galaxy
 * XR the runtime keeps the first profile a new swapchain receives, so a change is a new target.
 */
struct TargetFoveation {
    int level = 0;
    bool eyeTracked = false;
    bool foveated() const { return level != 0; }
    bool operator==(const TargetFoveation &other) const {
        return level == other.level && eyeTracked == other.eyeTracked;
    }
    bool operator!=(const TargetFoveation &other) const { return !(*this == other); }
};
struct RenderTargetRequest {
    std::array<RenderSize, 2> size{};
    TargetFoveation foveation;
    bool operator==(const RenderTargetRequest &other) const {
        return size == other.size && foveation == other.foveation;
    }
    bool operator!=(const RenderTargetRequest &other) const { return !(*this == other); }
};
/**
 * Replace targets only after a stable choice (size or foveation); a failed allocation waits for a
 * different choice. finish() records the targets actually bound, which can be below the request
 * when the runtime rejected part of it.
 */
class RenderTargetChanges {
  public:
    void reset(RenderTargetRequest current) {
        applied = pending = current;
        failed = false;
    }
    bool observe(RenderTargetRequest requested, double nowMs) {
        if (requested == applied) {
            pending = requested;
            failed = false;
            return false;
        }
        if (requested != pending) {
            pending = requested;
            changedAt = nowMs;
            failed = false;
            return false;
        }
        return !failed && nowMs - changedAt >= 250;
    }
    void finish(RenderTargetRequest bound, bool success) {
        if (success)
            applied = bound;
        failed = !success;
    }

  private:
    RenderTargetRequest applied{}, pending{};
    double changedAt = 0;
    bool failed = false;
};
/** Centered, bounded, even dimensions; the projection layer uses this exact rectangle. */
inline RenderRect renderRect(int width, int height, float scale) {
    scale = std::isfinite(scale) ? std::clamp(scale, .75f, 1.f) : 1.f;
    const int w = scale == 1.f ? width : std::clamp(static_cast<int>(width * scale) & ~1, 2, width);
    const int h =
        scale == 1.f ? height : std::clamp(static_cast<int>(height * scale) & ~1, 2, height);
    return {(width - w) / 2, (height - h) / 2, w, h};
}
} // namespace office
