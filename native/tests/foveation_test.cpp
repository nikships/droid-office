#include "foveation.h"
#include "foveation_filter_shader.h"
#include "foveation_overlay_shader.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <vector>
using namespace office;

namespace {
bool near(float a, float b) { return std::abs(a - b) < .0001f; }

FoveationSupport full() {
    FoveationSupport s;
    s.fbFoveation = s.configuration = s.updateState = s.qcomTexture = true;
    s.metaEyeTracked = s.systemEyeTracked = s.eyePermission = s.eyeGaze = true;
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
    assert(runtimeFoveation(full()) && eyeTrackedFoveation(full()));
    for (bool FoveationSupport::*need :
         {&FoveationSupport::fbFoveation, &FoveationSupport::configuration,
          &FoveationSupport::updateState, &FoveationSupport::qcomTexture}) {
        auto s = full();
        s.*need = false;
        assert(!runtimeFoveation(s) && !eyeTrackedFoveation(s));
    }
    for (bool FoveationSupport::*need :
         {&FoveationSupport::metaEyeTracked, &FoveationSupport::systemEyeTracked,
          &FoveationSupport::eyePermission}) {
        auto s = full();
        s.*need = false;
        assert(runtimeFoveation(s) && !eyeTrackedFoveation(s));
    }
    auto noGaze = full();
    noGaze.eyeGaze = false;
    assert(eyeTrackedFoveation(noGaze) && "eye gaze interaction is logged, not a spec dependency");
}

void plans() {
    // Nothing supported: targets without foveation support at every setting.
    FoveationPolicy none;
    assert(!none.swapchainFoveation() && !none.eyeTrackedAvailable());
    for (auto q : kQualities)
        assert(!none.desired(q).foveated() && !none.desired(q).eyeTracked);

    FoveationPolicy policy(full());
    assert(policy.swapchainFoveation() && policy.eyeTrackedAvailable());
    const auto off = policy.desired(FoveationQuality::Off);
    assert(!off.foveated() && !off.eyeTracked &&
           "Off is targets without foveation support, not a profile on foveated ones");
    for (auto q :
         {FoveationQuality::Clarity, FoveationQuality::Balanced, FoveationQuality::Performance}) {
        const auto target = policy.desired(q);
        assert(target.foveated() && target.eyeTracked && target.level == foveationLevel(q));
        assert(target.filtered && "every level is filtered when the reconstruction is available");
    }
    assert(!off.filtered && "Off renders the submitted swapchains directly");
    assert(policy.filterAvailable() && *policy.fallback() == 0);

    auto noFilter = full();
    noFilter.filter = false;
    FoveationPolicy unfiltered(noFilter);
    assert(!unfiltered.filterAvailable());
    const auto direct = unfiltered.desired(FoveationQuality::Performance);
    assert(direct.foveated() && direct.eyeTracked && !direct.filtered);
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

    auto denied = full();
    denied.eyePermission = false;
    const auto fixed = FoveationPolicy(denied).desired(FoveationQuality::Balanced);
    assert(fixed.foveated() && !fixed.eyeTracked && fixed.level == XR_FOVEATION_LEVEL_MEDIUM_FB &&
           "refused permission keeps fixed levels");
    assert(fixed != policy.desired(FoveationQuality::Balanced));
}

void degrade() {
    FoveationPolicy policy(full());
    const auto eye = policy.desired(FoveationQuality::Performance);
    assert(policy.rejected(eye) && "the same level is tried without eye tracking");
    assert(!policy.eyeTrackedAvailable() && *policy.fallback());
    const auto fixed = policy.desired(FoveationQuality::Performance);
    assert(fixed.foveated() && !fixed.eyeTracked && fixed.level == XR_FOVEATION_LEVEL_HIGH_FB);
    assert(!policy.rejected(fixed) && "a rejected fixed level leaves no profile to try");
    assert(!policy.swapchainFoveation());
    for (auto q : kQualities)
        assert(!policy.desired(q).foveated() && "the targets are recreated without foveation");
    assert(!policy.rejected(policy.desired(FoveationQuality::Balanced)));
    const std::string reason = policy.fallback();
    policy.swapchainFailed();
    assert(reason == policy.fallback() && "the first reason is kept");

    FoveationPolicy swapchain(full());
    swapchain.swapchainFailed();
    assert(!swapchain.swapchainFoveation() &&
           !swapchain.desired(FoveationQuality::Balanced).foveated());
    assert(*swapchain.fallback());

    auto denied = full();
    denied.systemEyeTracked = false;
    FoveationPolicy fixedOnly(denied);
    assert(!fixedOnly.rejected(fixedOnly.desired(FoveationQuality::Clarity)));
    assert(!fixedOnly.desired(FoveationQuality::Clarity).foveated());
}

void eyeTrackedFrames() {
    FoveationPolicy policy(full());
    assert(!policy.eyeTrackedState(XR_SUCCESS));
    // A failing query (nobody wearing the headset, closed eyes) keeps eye tracking and is tried
    // again on the next frame, however long it lasts.
    for (int i = 0; i < 10000; ++i)
        assert(!policy.eyeTrackedState(XR_ERROR_RUNTIME_FAILURE));
    assert(!policy.eyeTrackedState(XR_ERROR_HANDLE_INVALID));
    assert(policy.eyeTrackedAvailable() && policy.desired(FoveationQuality::Balanced).eyeTracked);
    assert(*policy.fallback() == 0);
    // Only an unsupported state drops it, once, and the next targets use the fixed level.
    assert(policy.eyeTrackedState(XR_ERROR_FEATURE_UNSUPPORTED));
    assert(!policy.eyeTrackedState(XR_ERROR_FEATURE_UNSUPPORTED) && "reported once");
    assert(!policy.eyeTrackedAvailable() && *policy.fallback());
    const auto fixed = policy.desired(FoveationQuality::Balanced);
    assert(fixed.foveated() && !fixed.eyeTracked && fixed.level == XR_FOVEATION_LEVEL_MEDIUM_FB);

    auto denied = full();
    denied.eyePermission = false;
    FoveationPolicy fixedOnly(denied);
    assert(!fixedOnly.eyeTrackedState(XR_ERROR_FEATURE_UNSUPPORTED) &&
           "nothing to drop without eye tracking");
}

void samples() {
    FoveationSamples s;
    const XrVector2f centers[2]{{-.2f, .1f}, {.3f, -.4f}};
    s.sample(XR_SUCCESS, XR_SUCCESS, true, centers);
    assert(s.frames == 1 && s.valid == 1 && s.centerValid);
    assert(near(s.center[0].x, -.2f) && near(s.center[1].y, -.4f));
    s.sample(XR_SUCCESS, XR_SUCCESS, false, centers);
    assert(s.invalid == 1 && !s.centerValid);
    s.sample(XR_SUCCESS, XR_ERROR_FEATURE_UNSUPPORTED, true, centers);
    assert(s.failed == 1 && !s.centerValid && s.state == XR_ERROR_FEATURE_UNSUPPORTED);
    s.sample(XR_SUCCESS, XR_SUCCESS, true, nullptr);
    assert(!s.centerValid && s.invalid == 2);
    assert(s.frames == 4);
    s.reset();
    assert(s.frames == 0 && s.valid == 0 && s.invalid == 0 && s.failed == 0 && !s.centerValid);
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
    assert(direct.foveated() && direct.eyeTracked && !direct.filtered &&
           direct.level == XR_FOVEATION_LEVEL_MEDIUM_FB);
    // The eye-tracked fallback keeps filtering.
    FoveationPolicy eye(full());
    assert(eye.rejected(eye.desired(FoveationQuality::Clarity)));
    const auto fixed = eye.desired(FoveationQuality::Clarity);
    assert(fixed.filtered && !fixed.eyeTracked && fixed.foveated());
    const std::string reason = eye.fallback();
    assert(eye.filterFailed(fixed) && reason == eye.fallback() && "the first reason is kept");
    // The runtime left the never-submitted swapchains unfoveated: same fallback, own reason.
    FoveationPolicy bare(full());
    assert(bare.filterFailed(bare.desired(FoveationQuality::Performance),
                             "filtered swapchain not foveated"));
    assert(std::string(bare.fallback()) == "filtered swapchain not foveated");
    assert(!bare.desired(FoveationQuality::Performance).filtered);
}

// One axis of a low-density bin as the driver stores it: each low-density pixel repeated over
// `step` full-resolution pixels, starting `phase` pixels into the first block.
std::vector<float> upscaled(const std::vector<float> &samples, int step, int phase) {
    std::vector<float> out(samples.size() * size_t(step));
    for (size_t x = 0; x < out.size(); ++x)
        out[x] = samples[std::min(samples.size() - 1, (x + size_t(phase)) / size_t(step))];
    return out;
}

// GL_LINEAR between texel centres (i + 0.5), clamped at the edges.
float linearTap(const std::vector<float> &image, float at) {
    const float t = at - .5f;
    const int i = int(std::floor(t));
    const float f = t - float(i);
    const auto texel = [&](int k) {
        return image[size_t(std::clamp(k, 0, int(image.size()) - 1))];
    };
    return texel(i) * (1 - f) + texel(i + 1) * f;
}

// The resolve fragment along one axis: the decoded step picks the taps (filterTaps,
// filterTapOffset), averaged with equal weights.
std::vector<float> resolved(const std::vector<float> &image, float step) {
    std::vector<float> out(image.size());
    const int n = filterTaps(step);
    for (size_t x = 0; x < image.size(); ++x) {
        float sum = 0;
        for (int i = 0; i < n; ++i)
            sum += linearTap(image, float(x) + .5f + filterTapOffset(i, n, step));
        out[x] = sum / float(n);
    }
    return out;
}

void filter() {
    // Steps round to half pixels; anything past the range reads as the coarsest.
    for (float sx : {1.f, 1.5f, 2.f, 3.f, 4.f, 8.f, 8.5f})
        for (float sy : {1.f, 2.f, 4.f, 8.5f}) {
            const auto back = decodeDensitySteps(encodeDensitySteps(sx, sy));
            assert(near(back[0], sx) && near(back[1], sy));
        }
    assert(encodeDensitySteps(1.f, 1.f) == 0 && "full density is code 0");
    assert(near(decodeDensitySteps(encodeDensitySteps(1.1f, .2f))[0], 1.f));
    assert(near(decodeDensitySteps(encodeDensitySteps(.2f, 1.f))[0], 1.f));
    assert(near(decodeDensitySteps(encodeDensitySteps(-4.f, 1.f))[0], 4.f));
    assert(near(decodeDensitySteps(encodeDensitySteps(64.f, 1.f))[0], 8.5f));
    const float nan = std::numeric_limits<float>::quiet_NaN();
    assert(near(decodeDensitySteps(encodeDensitySteps(nan, 1.f))[0], 8.5f));
    assert(encodeDensitySteps(8.5f, 8.5f) == 255);

    assert(filterTaps(1.f) == 1 && filterTaps(1.2f) == 1 && filterTaps(nan) == 1);
    assert(filterTaps(2.f) == 2 && filterTaps(3.f) == 3 && filterTaps(8.5f) == kMaxFilterTaps);
    assert(near(filterTapOffset(0, 1, 4.f), 0));
    assert(near(filterTapOffset(0, 2, 2.f), -.5f) && near(filterTapOffset(1, 2, 2.f), .5f));
    assert(near(filterTapOffset(0, 3, 3.f), -1.f) && near(filterTapOffset(2, 3, 3.f), 1.f));

    // Full density is copied, so the sharp region loses nothing.
    const std::vector<float> edge{0, 0, 0, 1, 1, 1, .3f, .3f, .8f, .1f, .1f, 1, 1, 1, 0, 0};
    const auto copied = resolved(edge, 1.f);
    for (size_t i = 0; i < edge.size(); ++i)
        assert(near(copied[i], edge[i]));

    for (int step : {2, 3, 4, 6, 8}) {
        for (int phase = 0; phase < step; ++phase) {
            const auto blocks = upscaled(edge, step, phase);
            const auto out = resolved(blocks, float(step));
            float largestStep = 0, largestBlockStep = 0;
            for (size_t x = size_t(2 * step); x + size_t(2 * step) < out.size(); ++x) {
                largestStep = std::max(largestStep, std::abs(out[x + 1] - out[x]));
                largestBlockStep = std::max(largestBlockStep, std::abs(blocks[x + 1] - blocks[x]));
            }
            // A 0 -> 1 edge between two low-density pixels is a single full-height step in the
            // driver's blocks. Filtered, it is spread over at least three output pixels: half
            // pixel steps for half density, a third or less for anything coarser.
            assert(near(largestBlockStep, 1.f));
            assert(largestStep <= (step == 2 ? .5f : 1.f / 3.f) + .001f);
            // Flat regions stay flat.
            const auto flat =
                resolved(upscaled(std::vector<float>(8, .25f), step, phase), float(step));
            for (float v : flat)
                assert(near(v, .25f));
        }
    }

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
        assert(s.densityFragment.find("dFdx(fc.x)") != std::string::npos);
        assert(s.densityFragment.find("dFdy(fc.y)") != std::string::npos);
        // The shader's code matches encodeDensitySteps/decodeDensitySteps and the tap table.
        assert(s.densityFragment.find("/ " + std::to_string(kDensityStepQuantum)) !=
               std::string::npos);
        assert(s.densityFragment.find("level.x * " + std::to_string(float(kDensityStepLevels))) !=
               std::string::npos);
        assert(s.resolveFragment.find("code / " + std::to_string(kDensityStepLevels)) !=
               std::string::npos);
        assert(s.resolveFragment.find("stepPx < 1.25 ? 1 : (stepPx < 2.25 ? 2 : " +
                                      std::to_string(kMaxFilterTaps)) != std::string::npos);
        assert(s.resolveFragment.find("((float(i) + 0.5) / float(n) - 0.5) * stepPx") !=
               std::string::npos);
        assert((s.resolveFragment.find("sampler2DArray source") != std::string::npos) == multiview);
        assert(s.resolveFragment.find("pixel = vec4(c.rgb, 1.0);") != std::string::npos &&
               "full density is a copy");
    }
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
        assert(s.fragment.find(std::to_string(kFoveaRingRadius)) != std::string::npos);
        // The marker uniform takes FoveaMarker values: magenta at the reported centre, white at
        // the image centre as the fallback.
        assert(s.fragment.find("uniform int marker;") != std::string::npos);
        assert(s.fragment.find("marker == 1 ?") != std::string::npos);
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
    eyeTrackedFrames();
    samples();
    filterDegrade();
    filter();
    overlay();
    std::cout << "runtime foveation targets, fallbacks, eye-tracked results, filter and overlay "
                 "checks passed\n";
}
