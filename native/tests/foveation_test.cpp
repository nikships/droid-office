#include "foveation.h"
#include "foveation_filter_shader.h"
#include "foveation_overlay_shader.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <string>
#include <vector>
using namespace office;

namespace {
bool near(float a, float b, float tolerance = .0001f) { return std::abs(a - b) < tolerance; }

FoveationSupport full() {
    FoveationSupport s;
    s.fbFoveation = s.configuration = s.updateState = s.qcomTexture = true;
    s.filter = true;
    return s;
}

constexpr FoveationQuality kQualities[]{FoveationQuality::Off, FoveationQuality::Clarity,
                                        FoveationQuality::Balanced, FoveationQuality::Performance};

void levels() {
    assert(foveationLevel(FoveationQuality::Off) == XR_FOVEATION_LEVEL_NONE_FB);
    assert(foveationLevel(FoveationQuality::Clarity) == XR_FOVEATION_LEVEL_LOW_FB);
    assert(foveationLevel(FoveationQuality::Balanced) == XR_FOVEATION_LEVEL_MEDIUM_FB);
    assert(foveationLevel(FoveationQuality::Performance) == XR_FOVEATION_LEVEL_HIGH_FB);
    assert(!strcmp(foveationQualityName(FoveationQuality::Off), "off"));
    assert(!strcmp(foveationQualityName(FoveationQuality::Balanced), "balanced"));
    TargetFoveation target;
    assert(!target.foveated() && !strcmp(foveationLevelName(target), "none"));
    target.level = XR_FOVEATION_LEVEL_HIGH_FB;
    assert(target.foveated() && !strcmp(foveationLevelName(target), "high"));
    target.level = XR_FOVEATION_LEVEL_LOW_FB;
    assert(!strcmp(foveationLevelName(target), "low"));
    target.level = XR_FOVEATION_LEVEL_MEDIUM_FB;
    assert(!strcmp(foveationLevelName(target), "medium"));
}

void capabilities() {
    assert(runtimeFoveation(full()));
    for (bool FoveationSupport::*need :
         {&FoveationSupport::fbFoveation, &FoveationSupport::configuration,
          &FoveationSupport::updateState, &FoveationSupport::qcomTexture}) {
        auto s = full();
        s.*need = false;
        assert(!runtimeFoveation(s));
    }
    auto noFilter = full();
    noFilter.filter = false;
    assert(runtimeFoveation(noFilter) && "the filter is an addition, not a foveation dependency");
}

void plans() {
    // Nothing supported: targets without foveation support at every setting.
    FoveationPolicy none;
    assert(!none.swapchainFoveation());
    for (auto q : kQualities)
        assert(!none.desired(q).foveated() && !none.desired(q).filtered);

    FoveationPolicy policy(full());
    assert(policy.swapchainFoveation());
    const auto off = policy.desired(FoveationQuality::Off);
    assert(!off.foveated() && "Off is targets without foveation support, not a profile on them");
    for (auto q :
         {FoveationQuality::Clarity, FoveationQuality::Balanced, FoveationQuality::Performance}) {
        const auto target = policy.desired(q);
        assert(target.foveated() && target.level == foveationLevel(q));
        assert(target.filtered && "every level is filtered when the reconstruction is available");
    }
    assert(!off.filtered && "Off renders the submitted swapchains directly");
    assert(policy.filterAvailable() && *policy.fallback() == 0);

    auto noFilter = full();
    noFilter.filter = false;
    FoveationPolicy unfiltered(noFilter);
    assert(!unfiltered.filterAvailable());
    const auto direct = unfiltered.desired(FoveationQuality::Performance);
    assert(direct.foveated() && !direct.filtered);
    assert(direct != policy.desired(FoveationQuality::Performance));
    assert(!unfiltered.filterFailed(direct) && "nothing to drop without the reconstruction");

    // Every setting change is a different target, so the world swapchains are recreated.
    for (auto a : kQualities)
        for (auto b : kQualities)
            assert((policy.desired(a) == policy.desired(b)) == (a == b));
    RenderTargetRequest balanced{{RenderSize{1856, 2160}, {}},
                                 policy.desired(FoveationQuality::Balanced)};
    auto offTargets = balanced;
    offTargets.foveation = off;
    assert(balanced != offTargets && "same size, Off: new targets");
}

void degrade() {
    FoveationPolicy policy(full());
    const auto level = policy.desired(FoveationQuality::Performance);
    policy.rejected(level);
    assert(!policy.swapchainFoveation() && *policy.fallback());
    for (auto q : kQualities)
        assert(!policy.desired(q).foveated() && "the targets are recreated without foveation");
    const std::string reason = policy.fallback();
    policy.swapchainFailed();
    assert(reason == policy.fallback() && "the first reason is kept");

    FoveationPolicy offOnly(full());
    offOnly.rejected(offOnly.desired(FoveationQuality::Off));
    assert(offOnly.swapchainFoveation() && *offOnly.fallback() == 0 && "Off has no profile");

    FoveationPolicy swapchain(full());
    swapchain.swapchainFailed();
    assert(!swapchain.swapchainFoveation() &&
           !swapchain.desired(FoveationQuality::Balanced).foveated());
    assert(*swapchain.fallback());
}

void filterDegrade() {
    FoveationPolicy policy(full());
    const auto filtered = policy.desired(FoveationQuality::Balanced);
    assert(filtered.filtered);
    assert(!policy.filterFailed(policy.desired(FoveationQuality::Off)) &&
           "Off targets are never filtered");
    assert(policy.filterFailed(filtered) && "unfiltered targets are tried next");
    assert(!policy.filterAvailable() && *policy.fallback());
    assert(!policy.filterFailed(filtered) && "dropped once");
    const auto direct = policy.desired(FoveationQuality::Balanced);
    assert(direct.foveated() && !direct.filtered && direct.level == XR_FOVEATION_LEVEL_MEDIUM_FB);
    // The runtime left the foveated set unfoveated even submitted: same fallback, own reason.
    FoveationPolicy bare(full());
    assert(bare.filterFailed(bare.desired(FoveationQuality::Performance),
                             "filtered swapchain not foveated"));
    assert(std::string(bare.fallback()) == "filtered swapchain not foveated");
    assert(!bare.desired(FoveationQuality::Performance).filtered);
}

void frames() {
    // Filtered targets go through the filter only when the drawn image is foveated and the
    // workspace panel is not beneath the world layer; everything else is submitted as drawn.
    assert(filterFrame(true, false, true));
    assert(!filterFrame(true, false, false) && "an unfoveated image primes its swapchain");
    assert(!filterFrame(true, true, true) && "the panel's hole stays in the alpha");
    assert(!filterFrame(true, true, false));
    for (bool underlay : {false, true})
        for (bool foveated : {false, true})
            assert(!filterFrame(false, underlay, foveated));

    FoveationFrames counts;
    counts.filtered = 3;
    counts.priming = 1;
    counts.underlay = 2;
    counts.reset();
    assert(counts.filtered == 0 && counts.priming == 0 && counts.underlay == 0);
}

void primingImages() {
    FoveationPriming priming;
    assert(!priming.complete() && !priming.known(0, 0) && "no targets: nothing known");
    priming.reset(1, 4);
    for (uint32_t i = 0; i < 4; ++i)
        assert(!priming.known(0, i));
    assert(!priming.observe(0, 0, 0) && !priming.known(0, 0));
    // The first submission foveates every image of the swapchain; each is read once.
    assert(!priming.submittedUnfoveated());
    assert(priming.primingFrames() == 1);
    assert(priming.observe(0, 1, 3) && priming.known(0, 1));
    assert(!priming.complete());
    for (uint32_t i : {0u, 2u, 3u})
        assert(priming.observe(0, i, 3));
    assert(priming.complete());
    assert(priming.observe(0, 2, 1) && "FOVEATION_ENABLE_BIT_QCOM alone is foveated");
    assert(priming.observe(0, 9, 3) && "an out-of-range image is still read as foveated");
    assert(!priming.known(0, 9) && !priming.known(-1, 0) && !priming.known(1, 0) &&
           "but never stored");

    // Non-multiview: one foveated swapchain per eye, tracked separately.
    priming.reset(2, 3);
    assert(!priming.complete());
    for (uint32_t i = 0; i < 3; ++i)
        priming.observe(0, i, 3);
    assert(priming.known(0, 2) && !priming.known(1, 2) && !priming.complete());
    for (uint32_t i = 0; i < 3; ++i)
        priming.observe(1, i, 3);
    assert(priming.complete());

    // A set the runtime never foveates, even submitted, is reported once.
    priming.reset(1, 3);
    for (uint32_t i = 1; i < FoveationPriming::kGiveUpFrames; ++i)
        assert(!priming.submittedUnfoveated());
    assert(priming.submittedUnfoveated());
    assert(!priming.submittedUnfoveated() && "reported once");
    priming.reset(1, 3);
    assert(priming.primingFrames() == 0 && !priming.submittedUnfoveated());
}

// GL_LINEAR between texel centres (i + 0.5), clamped at the edges, along one axis.
float linearTap(const std::vector<float> &image, float at) {
    const float t = at - .5f;
    const int i = int(std::floor(t));
    const float f = t - float(i);
    const auto texel = [&](int k) {
        return image[size_t(std::clamp(k, 0, int(image.size()) - 1))];
    };
    return texel(i) * (1 - f) + texel(i + 1) * f;
}

// One row as the driver stores it: bins [start, end) rendered at a block width, each invocation
// sampling `scene` at its full-resolution position and repeated over its block. The density pass
// writes the invocation's code over the same block. `firstPixel` scales gl_FragCoord to the centre
// of the block's first pixel instead of the block centre.
struct Bin {
    int start, end, width;
};
struct Row {
    std::vector<float> image;
    std::vector<int> code;
    std::vector<float> reference; // bilinear between this bin's own block centres
    std::vector<bool> interior;   // both blocks of the bilinear blend are inside the bin
};
Row driverRow(const std::vector<Bin> &bins, const std::function<float(float)> &scene,
              bool firstPixel = false) {
    Row row;
    const int size = bins.back().end;
    row.image.resize(size_t(size));
    row.code.resize(size_t(size));
    row.reference.resize(size_t(size));
    row.interior.resize(size_t(size));
    for (const auto &bin : bins) {
        const int blocks = (bin.end - bin.start + bin.width - 1) / bin.width;
        std::vector<float> samples(static_cast<size_t>(blocks));
        for (int k = 0; k < blocks; ++k) {
            const float centre = float(bin.start) + (float(k) + .5f) * float(bin.width);
            samples[size_t(k)] = scene(centre);
            const float fragCoord = firstPixel ? float(bin.start + k * bin.width) + .5f : centre;
            const int code = densityAxisCode(fragCoord, float(bin.width));
            for (int x = bin.start + k * bin.width;
                 x < std::min(bin.end, bin.start + (k + 1) * bin.width); ++x) {
                row.image[size_t(x)] = samples[size_t(k)];
                row.code[size_t(x)] = code;
            }
        }
        for (int x = bin.start; x < bin.end; ++x) {
            const float u = (float(x) + .5f - float(bin.start)) / float(bin.width) - .5f;
            const int k0 = int(std::floor(u));
            const float t = u - float(k0);
            const auto sample = [&](int k) {
                return samples[size_t(std::clamp(k, 0, blocks - 1))];
            };
            row.reference[size_t(x)] = sample(k0) * (1 - t) + sample(k0 + 1) * t;
            row.interior[size_t(x)] = k0 >= 0 && k0 + 1 < blocks;
        }
    }
    return row;
}

// The resolve fragment along one axis, as resolveFragment computes it.
std::vector<float> resolveRow(const Row &row) {
    std::vector<float> out(row.image.size());
    for (size_t x = 0; x < out.size(); ++x) {
        const int code = row.code[x];
        if (code == 0) {
            out[x] = row.image[x];
            continue;
        }
        const float at = densityTapCoordinate(int(x), decodeDensityAxis(code));
        out[x] = code == kDensityUnknown
                     ? .5f * (linearTap(row.image, at - .5f) + linearTap(row.image, at + .5f))
                     : linearTap(row.image, at);
    }
    return out;
}

void codes() {
    // Full density is code 0 whatever the position, so the fovea is always a plain copy.
    for (float fc : {.5f, 1.5f, 17.5f, 2303.5f})
        for (float step : {1.f, 1.2f, .5f, 0.f})
            assert(densityAxisCode(fc, step) == 0);
    assert(encodeDensityCode(0, 0) == 0);
    // Every width and start the code describes round-trips, for both gl_FragCoord conventions.
    for (int width : {2, 4, 8})
        for (int start = 0; start < 40; ++start) {
            const float centre = float(start) + .5f * float(width);
            const int code = densityAxisCode(centre, float(width));
            const auto axis = decodeDensityAxis(code);
            assert(axis.width == width && axis.phase == start % width);
            assert(code >= 1 && code < kDensityUnknown);
            assert(densityAxisCode(float(start) + .5f, float(width)) == code &&
                   "a first-pixel gl_FragCoord gives the same block");
            assert(densityAxisCode(centre, -float(width)) == code && "a negative step is a width");
            assert(densityAxisCode(centre + .001f, float(width) * 1.005f) == code &&
                   "float noise on the derivative and position is tolerated");
        }
    // Codes are distinct per width and phase, and every code decodes to a describable block.
    std::vector<int> seen;
    for (int width : {2, 4, 8})
        for (int phase = 0; phase < width; ++phase)
            seen.push_back(densityAxisCode(float(phase) + .5f * float(width), float(width)));
    std::sort(seen.begin(), seen.end());
    assert(std::unique(seen.begin(), seen.end()) == seen.end() && seen.size() == 14);
    assert(seen.front() == 1 && seen.back() == kDensityUnknown - 1);
    // Anything else is unknown: other widths, starts off the pixel grid, non-finite input.
    const float nan = std::numeric_limits<float>::quiet_NaN();
    for (float step :
         {1.5f, 3.f, 6.f, 2.3f, 16.f, 64.f, nan, std::numeric_limits<float>::infinity()})
        assert(densityAxisCode(10.f, step) == kDensityUnknown);
    assert(densityAxisCode(10.25f, 2.f) == kDensityUnknown && "a start between pixels");
    assert(densityAxisCode(nan, 2.f) == kDensityUnknown);
    assert(decodeDensityAxis(kDensityUnknown).width == 0);
    assert(decodeDensityAxis(0).width == 1);
    assert(encodeDensityCode(kDensityUnknown, kDensityUnknown) == 255);
    assert(encodeDensityCode(3, 7) == 3 * 16 + 7);
    // The tap of a full-density or unknown axis is the pixel's own centre.
    assert(near(densityTapCoordinate(12, {1, 0}), 12.5f));
    assert(near(densityTapCoordinate(12, {0, 0}), 12.5f));
    // Half density starting at 0: pixel 0 is 0.5 px from its block centre (1.0), so it keeps
    // 3/4 of its own block and takes 1/4 of the previous one.
    assert(near(densityTapCoordinate(0, {2, 0}), .25f));
    assert(near(densityTapCoordinate(1, {2, 0}), 1.75f));
    assert(near(densityTapCoordinate(2, {2, 0}), 2.25f));
}

void bilinear() {
    // A scene with an edge, a ramp and fine detail.
    const auto scene = [](float x) {
        return (x > 37.f ? .8f : .1f) + .004f * x + .05f * std::sin(x * .7f);
    };
    for (bool firstPixel : {false, true})
        for (int width : {2, 4, 8})
            for (int offset : {0, 1, 3, 5, 6}) {
                // A full-density bin, the reduced bin (starting off its width's grid), then
                // another full-density bin.
                const std::vector<Bin> bins{
                    {0, 16 + offset, 1},
                    {16 + offset, 16 + offset + 12 * width, width},
                    {16 + offset + 12 * width, 40 + offset + 12 * width, 1}};
                const Row row = driverRow(bins, scene, firstPixel);
                const auto out = resolveRow(row);
                for (size_t x = 0; x < out.size(); ++x) {
                    if (row.code[x] == 0) {
                        assert(out[x] == row.image[x] && "full density is copied, not resampled");
                        continue;
                    }
                    const auto axis = decodeDensityAxis(row.code[x]);
                    assert(axis.width == width && axis.phase == (16 + offset) % width);
                    if (row.interior[x])
                        assert(near(out[x], row.reference[x], 1e-5f) &&
                               "a bilinear upsample of the bin's own blocks");
                }
                // No hard block edges: the reduced bin changes by at most one block difference
                // over its width per pixel, and blends into the full-density bins beside it.
                float largestBlockStep = 0, largestStep = 0;
                for (size_t x = 1; x < out.size(); ++x) {
                    if (row.code[x] && row.code[x - 1]) {
                        largestBlockStep =
                            std::max(largestBlockStep, std::abs(row.image[x] - row.image[x - 1]));
                        largestStep = std::max(largestStep, std::abs(out[x] - out[x - 1]));
                    }
                }
                assert(largestStep <= largestBlockStep / float(width) * 1.001f + 1e-6f);
                assert(largestBlockStep > .5f && "the edge falls inside the reduced bin");
            }
    // Bilinear reconstruction keeps flat regions flat and ramps straight.
    for (int width : {2, 4, 8}) {
        const Row flat = driverRow({{0, 8 * width, width}}, [](float) { return .25f; });
        for (float v : resolveRow(flat))
            assert(near(v, .25f));
        const Row ramp = driverRow({{0, 16 * width, width}}, [](float x) { return x / 512.f; });
        const auto out = resolveRow(ramp);
        for (size_t x = size_t(width); x + size_t(width) < out.size(); ++x)
            assert(near(out[x], (float(x) + .5f) / 512.f, 1e-5f) && "linear stays linear");
    }
    // Blocks the code cannot describe are smoothed [1 2 1] / 4 instead of left as blocks.
    const Row odd = driverRow({{0, 33, 3}}, [](float x) { return x > 16.f ? 1.f : 0.f; });
    for (int c : odd.code)
        assert(c == kDensityUnknown);
    const auto smoothed = resolveRow(odd);
    for (size_t x = 1; x + 1 < smoothed.size(); ++x)
        assert(near(smoothed[x],
                    .25f * odd.image[x - 1] + .5f * odd.image[x] + .25f * odd.image[x + 1]));
}

// GL_LINEAR in 2D: the separable product of linearTap on each axis.
float bilinearTap(const std::vector<float> &image, int w, int h, float atX, float atY) {
    const float tx = atX - .5f, ty = atY - .5f;
    const int x0 = int(std::floor(tx)), y0 = int(std::floor(ty));
    const float fx = tx - float(x0), fy = ty - float(y0);
    const auto texel = [&](int x, int y) {
        return image[size_t(std::clamp(y, 0, h - 1) * w + std::clamp(x, 0, w - 1))];
    };
    return (texel(x0, y0) * (1 - fx) + texel(x0 + 1, y0) * fx) * (1 - fy) +
           (texel(x0, y0 + 1) * (1 - fx) + texel(x0 + 1, y0 + 1) * fx) * fy;
}

void anisotropic() {
    // One bin of 2 x 4 blocks (Galaxy XR showed bins reduced on one axis only), starting at
    // (1, 2); the resolve's single tap equals the 2D bilinear upsample of its blocks.
    constexpr int w = 40, h = 48, bx = 1, by = 2, sx = 2, sy = 4;
    const auto scene = [](float x, float y) {
        return .3f + .01f * x - .007f * y + .2f * ((x > 20.f) ^ (y > 30.f));
    };
    std::vector<float> image(size_t(w * h));
    std::vector<uint8_t> code(size_t(w * h));
    const int blocksX = (w - bx) / sx, blocksY = (h - by) / sy;
    std::vector<float> samples(size_t(blocksX * blocksY));
    for (int ky = 0; ky < blocksY; ++ky)
        for (int kx = 0; kx < blocksX; ++kx) {
            const float cx = float(bx) + (float(kx) + .5f) * sx,
                        cy = float(by) + (float(ky) + .5f) * sy;
            samples[size_t(ky * blocksX + kx)] = scene(cx, cy);
            const auto c = encodeDensityCode(densityAxisCode(cx, sx), densityAxisCode(cy, sy));
            for (int y = by + ky * sy; y < by + (ky + 1) * sy; ++y)
                for (int x = bx + kx * sx; x < bx + (kx + 1) * sx; ++x) {
                    image[size_t(y * w + x)] = samples[size_t(ky * blocksX + kx)];
                    code[size_t(y * w + x)] = c;
                }
        }
    for (int y = by + sy; y < by + (blocksY - 1) * sy; ++y)
        for (int x = bx + sx; x < bx + (blocksX - 1) * sx; ++x) {
            const int c = code[size_t(y * w + x)];
            const auto ax = decodeDensityAxis(c / kDensityCodeLevels),
                       ay = decodeDensityAxis(c % kDensityCodeLevels);
            assert(ax.width == sx && ay.width == sy && ax.phase == bx % sx && ay.phase == by % sy);
            const float out =
                bilinearTap(image, w, h, densityTapCoordinate(x, ax), densityTapCoordinate(y, ay));
            const float ux = (float(x) + .5f - float(bx)) / sx - .5f,
                        uy = (float(y) + .5f - float(by)) / sy - .5f;
            const int kx = int(std::floor(ux)), ky = int(std::floor(uy));
            const float fx = ux - float(kx), fy = uy - float(ky);
            const auto s = [&](int i, int j) { return samples[size_t(j * blocksX + i)]; };
            const float ref = (s(kx, ky) * (1 - fx) + s(kx + 1, ky) * fx) * (1 - fy) +
                              (s(kx, ky + 1) * (1 - fx) + s(kx + 1, ky + 1) * fx) * fy;
            assert(near(out, ref, 1e-5f));
        }
}

void shaders() {
    for (bool multiview : {true, false}) {
        const auto s = foveationFilterShaders(multiview);
        const auto again = foveationFilterShaders(multiview);
        assert(s.vertex == again.vertex && s.densityFragment == again.densityFragment &&
               s.resolveFragment == again.resolveFragment);
        for (const std::string *stage : {&s.vertex, &s.densityFragment, &s.resolveFragment})
            assert(stage->rfind("#version 300 es\n", 0) == 0);
        assert((s.vertex.find("num_views = 2") != std::string::npos) == multiview);
        assert((s.vertex.find("gl_ViewID_OVR") != std::string::npos) == multiview);
        assert(s.densityFragment.find("gl_ViewID_OVR") == std::string::npos);
        assert(s.resolveFragment.find("gl_ViewID_OVR") == std::string::npos);
        // The density pass measures both axes and codes them as densityAxisCode does.
        assert(s.densityFragment.find("dFdx(fc.x)") != std::string::npos);
        assert(s.densityFragment.find("dFdy(fc.y)") != std::string::npos);
        assert(s.densityFragment.find(densityAxisCodeGlsl()) != std::string::npos);
        assert(s.densityFragment.find("axisCode(fc.x, stepPx.x) * 16 + axisCode(fc.y, stepPx.y)") !=
               std::string::npos);
        // The resolve decodes the codes and taps once, as densityTapCoordinate does.
        assert(s.resolveFragment.find("int cx = code / 16;") != std::string::npos);
        assert(s.resolveFragment.find("int width = code < 3 ? 2 : (code < 7 ? 4 : 8);") !=
               std::string::npos);
        assert(s.resolveFragment.find("int start = x - (x - phase + 8) % width;") !=
               std::string::npos);
        assert(
            s.resolveFragment.find("float(start) + w - 0.5 + d / w : float(start) + 0.5 + d / w") !=
            std::string::npos);
        assert((s.resolveFragment.find("sampler2DArray source") != std::string::npos) == multiview);
        assert(s.resolveFragment.find("pixel = vec4(c.rgb, 1.0);") != std::string::npos &&
               "full density is a copy");
    }
    // The GLSL mirror uses the same thresholds as the C++ one.
    const auto glsl = densityAxisCodeGlsl();
    for (const char *part : {"stepPx < 12.0", "stepPx < 1.25", "stepPx < 3.0", "stepPx < 6.0",
                             "0.01 * width", "> 0.0625"})
        assert(glsl.find(part) != std::string::npos);
}

void overlay() {
    assert(densityBand(1.f) == 0 && densityBand(1.2f) == 0);
    assert(densityBand(2.f) == 1 && densityBand(-2.f) == 1);
    assert(densityBand(3.f) == 2);
    assert(densityBand(4.f) == 3 && densityBand(16.f) == 3);
    assert(densityBand(std::numeric_limits<float>::quiet_NaN()) == 3);
    assert(densityBand(std::numeric_limits<float>::infinity()) == 3);
    for (size_t i = 1; i < kDensityBandEdges.size(); ++i)
        assert(kDensityBandEdges[i - 1] < kDensityBandEdges[i]);
    auto p = foveaPixel(0, 0, 3152, 3668);
    assert(near(p[0], 1576) && near(p[1], 1834));
    p = foveaPixel(-1, -1, 3152, 3668);
    assert(near(p[0], 0) && near(p[1], 0));
    p = foveaPixel(1, 1, 3152, 3668);
    assert(near(p[0], 3152) && near(p[1], 3668));
    p = foveaPixel(.5f, -.5f, 2000, 1000);
    assert(near(p[0], 1500) && near(p[1], 250) && "NDC y up, GL image origin bottom-left");
    p = foveaPixel(4, -9, 100, 100);
    assert(near(p[0], 100) && near(p[1], 0));
    p = foveaPixel(std::numeric_limits<float>::quiet_NaN(), 0, 100, 100);
    assert(near(p[0], 50));

    for (bool multiview : {true, false}) {
        const auto s = foveationOverlayShader(multiview);
        const auto again = foveationOverlayShader(multiview);
        assert(s.vertex == again.vertex && s.fragment == again.fragment);
        assert(s.vertex.rfind("#version 300 es\n", 0) == 0);
        assert(s.fragment.rfind("#version 300 es\n", 0) == 0);
        assert((s.vertex.find("num_views = 2") != std::string::npos) == multiview);
        assert((s.vertex.find("gl_ViewID_OVR") != std::string::npos) == multiview);
        assert((s.vertex.find("uniform int eye;") != std::string::npos) == !multiview);
        assert(s.fragment.find("gl_ViewID_OVR") == std::string::npos);
        assert(s.fragment.find("dFdx(fc.x)") != std::string::npos);
        for (float edge : kDensityBandEdges)
            assert(s.fragment.find("stepPx < " + std::to_string(edge)) != std::string::npos);
        // Blocks the filter only smooths are marked with their own tint.
        assert(s.fragment.find(densityAxisCodeGlsl()) != std::string::npos);
        assert(s.fragment.find("!described ? vec3(" + std::to_string(kUndescribedTint[0])) !=
               std::string::npos);
        assert(s.fragment.find(std::to_string(kFoveaRingRadius)) != std::string::npos);
        // The marker uniform takes FoveaMarker values: the image centre on fixed foveation.
        assert(s.fragment.find("uniform int marker;") != std::string::npos);
        assert(s.fragment.find(": vec2(0.0)") != std::string::npos);
    }
    assert(static_cast<int>(FoveaMarker::None) == 0 &&
           static_cast<int>(FoveaMarker::Reported) == 1 &&
           static_cast<int>(FoveaMarker::ImageCentre) == 2);
}
} // namespace

int main() {
    levels();
    capabilities();
    plans();
    degrade();
    filterDegrade();
    frames();
    primingImages();
    codes();
    bilinear();
    anisotropic();
    shaders();
    overlay();
    std::cout << "fixed runtime foveation targets, fallbacks, priming, density codes, bilinear "
                 "filter and overlay checks passed\n";
}
