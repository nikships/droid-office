#include "graphics_controls.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
using namespace office;
bool near(float a, float b) { return std::abs(a - b) < .00001f; }
int main() {
    const ResolutionLimits limits{{1856, 2160}, {3152, 3682}};
    assert(near(maximumRenderScale(limits), 3152.f / 1856.f));
    assert((renderSize(limits, 1) == RenderSize{1856, 2160}));
    assert((renderSize(limits, 1.5f) == RenderSize{2784, 3240}));
    assert((renderSize(limits, maximumRenderScale(limits)) == RenderSize{3152, 3668}));
    assert(renderSize(limits, 5) == renderSize(limits, maximumRenderScale(limits)));
    assert(renderSize(limits, -1) == renderSize(limits, .75f));
    assert(renderSize(limits, std::numeric_limits<float>::quiet_NaN()) == renderSize(limits, 1));
    const ResolutionLimits heightLimited{{2000, 2000}, {4000, 3001}};
    assert((renderSize(heightLimited, 2) == RenderSize{3000, 3000}));
    assert((renderSize({{100, 100}, {1000, 1000}}, 5) == RenderSize{200, 200}));
    assert((renderSize({{8, 8}, {5, 3}}, .75f) == RenderSize{2, 2}));
    for (int i = 75; i <= 200; ++i) {
        const auto size = renderSize(limits, i / 100.f);
        assert(size.width >= 2 && size.height >= 2 && size.width % 2 == 0 && size.height % 2 == 0);
        assert(size.width <= limits.maximum.width && size.height <= limits.maximum.height);
        assert(std::abs(float(size.width) / size.height - 1856.f / 2160.f) < .002f);
    }
    RenderTargetChanges changes;
    const TargetFoveation medium{2, true};
    RenderTargetRequest recommended{{renderSize(limits, 1), {}}, medium};
    RenderTargetRequest maximum{{renderSize(limits, 2), {}}, medium};
    changes.reset(recommended);
    assert(!changes.observe(recommended, 0));
    assert(!changes.observe(maximum, 100));
    assert(!changes.observe(maximum, 349));
    assert(changes.observe(maximum, 350));
    changes.finish(maximum, true);
    assert(!changes.observe(maximum, 900));
    // Off and every level change are new targets of the same size.
    auto unfoveated = maximum;
    unfoveated.foveation = {};
    assert(!unfoveated.foveation.foveated() && unfoveated != maximum);
    assert(!changes.observe(unfoveated, 1000));
    assert(changes.observe(unfoveated, 1250));
    changes.finish(unfoveated, false);
    assert(!changes.observe(unfoveated, 10000) && "failed allocations must not stall every frame");
    auto high = maximum;
    high.foveation.level = 3;
    assert(high != maximum && !changes.observe(high, 10100));
    assert(changes.observe(high, 10350));
    // The runtime rejected the eye-tracked profile: the bound targets are the fixed level, and a
    // request that matches them later is not replaced again.
    auto highFixed = high;
    highFixed.foveation.eyeTracked = false;
    changes.finish(highFixed, true);
    assert(!changes.observe(highFixed, 20000) && !changes.observe(highFixed, 30000));
    assert(!changes.observe(recommended, 31000));
    assert(changes.observe(recommended, 31250));
    changes.finish(recommended, true);
    assert(!changes.observe(recommended, 40000));
    const auto full = renderRect(1856, 2160, 1);
    assert(full.x == 0 && full.y == 0 && full.width == 1856 && full.height == 2160);
    for (float scale : {.75f, .8f, .9f}) {
        const auto r = renderRect(1856, 2160, scale);
        assert(r.width > 0 && r.height > 0 && r.width % 2 == 0 && r.height % 2 == 0);
        assert(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1856 && r.y + r.height <= 2160);
        assert(std::abs(r.width / 1856.f - scale) < .002f);
        assert(std::abs(r.height / 2160.f - scale) < .002f);
        assert(r.x + r.width / 2 == 1856 / 2 && r.y + r.height / 2 == 2160 / 2);
    }
    assert(renderRect(1856, 2160, 4).width == full.width);
    assert(renderRect(1856, 2160, std::numeric_limits<float>::quiet_NaN()).height == full.height);
    const auto low = renderRect(1856, 2160, -1);
    assert(low.width == renderRect(1856, 2160, .75f).width);
    const GraphicsControls defaults;
    assert(defaults.foveation == FoveationQuality::Balanced && !defaults.foveationDebug);
    const TargetFoveation none;
    assert(!none.foveated() && none == TargetFoveation{} && none != medium);
    std::cout << "graphics maximum resolution, viewport and target change checks passed\n";
}
