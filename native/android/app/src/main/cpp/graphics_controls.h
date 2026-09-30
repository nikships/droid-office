#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace office {
enum class FoveationQuality { Balanced, Clarity, Performance };
struct GraphicsControls {
    float renderScale = 1.f;
    float peripheralDensity = .25f;
    FoveationQuality foveation = FoveationQuality::Balanced;
    bool sharpScreens = true;
};
struct RenderRect {
    int x = 0, y = 0, width = 0, height = 0;
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
