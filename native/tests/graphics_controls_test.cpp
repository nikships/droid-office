#include "graphics_controls.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
using namespace office;
bool near(float a, float b) { return std::abs(a - b) < .00001f; }
int main() {
    const auto full = renderRect(1856, 2160, 1);
    assert(full.x == 0 && full.y == 0 && full.width == 1856 && full.height == 2160);
    for (float scale : {.75f, .8f, .9f}) {
        const auto r = renderRect(1856, 2160, scale);
        assert(r.width > 0 && r.height > 0 && r.width % 2 == 0 && r.height % 2 == 0);
        assert(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1856 && r.y + r.height <= 2160);
        assert(std::abs(r.width / 1856.f - scale) < .002f);
        assert(std::abs(r.height / 2160.f - scale) < .002f);
        const auto center = textureFocalPoint(r, 1856, 2160, 0, 0);
        assert(near(center[0], 0) && near(center[1], 0));
        const auto corner = textureFocalPoint(r, 1856, 2160, 1, -1);
        assert(near(corner[0], r.width / 1856.f) && near(corner[1], -r.height / 2160.f));
    }
    assert(renderRect(1856, 2160, 4).width == full.width);
    assert(renderRect(1856, 2160, std::numeric_limits<float>::quiet_NaN()).height == full.height);
    const auto low = renderRect(1856, 2160, -1);
    assert(low.width == renderRect(1856, 2160, .75f).width);
    for (auto quality :
         {FoveationQuality::Balanced, FoveationQuality::Clarity, FoveationQuality::Performance}) {
        auto valid = foveationProfile(quality, true), fallback = foveationProfile(quality, false);
        assert(valid.gain >= 3 && valid.gain <= 5 && valid.area > 0);
        assert(fallback.gain == valid.gain && fallback.area > valid.area);
    }
    assert(foveationProfile(FoveationQuality::Balanced, true).gain == 4);
    assert(foveationProfile(FoveationQuality::Balanced, true).area == 2);
    std::cout << "graphics viewport, gaze mapping and fallback checks passed\n";
}
