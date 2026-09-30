#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace office {
enum class FoveationQuality { Balanced, Clarity, Performance, Off };
struct GraphicsControls {
    float renderScale = 1.f;
    float peripheralDensity = .25f;
    FoveationQuality foveation = FoveationQuality::Balanced;
    bool sharpScreens = true;
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
struct RenderTargetRequest {
    std::array<RenderSize, 2> size{};
    bool foveated = false;
    bool operator==(const RenderTargetRequest &other) const {
        return size == other.size && foveated == other.foveated;
    }
    bool operator!=(const RenderTargetRequest &other) const { return !(*this == other); }
};
/** Resize only after a stable choice; a failed allocation waits for a different user choice. */
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
    void finish(RenderTargetRequest requested, bool success) {
        if (success)
            applied = requested;
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
/** The QCOM fovea is expressed over the allocated texture, rather than the smaller viewport. */
inline std::array<float, 2> textureFocalPoint(RenderRect rect, int width, int height, float x,
                                              float y) {
    return {(2.f * rect.x + rect.width) / width - 1.f + x * rect.width / width,
            (2.f * rect.y + rect.height) / height - 1.f + y * rect.height / height};
}
struct FoveationProfile {
    float gain = 4.f;
    float area = 2.f;
};
inline FoveationProfile foveationProfile(FoveationQuality quality, bool gazeValid) {
    const float gain = quality == FoveationQuality::Clarity       ? 3.f
                       : quality == FoveationQuality::Performance ? 5.f
                                                                  : 4.f;
    return {gain, gazeValid ? (quality == FoveationQuality::Performance ? 1.8f : 2.f) : 4.f};
}
} // namespace office
