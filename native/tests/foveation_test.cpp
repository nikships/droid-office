#include "foveation.h"
#include "foveation_overlay_shader.h"
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
using namespace office;

namespace {
bool near(float a, float b) { return std::abs(a - b) < .0001f; }

FoveationSupport full() {
    FoveationSupport s;
    s.fbFoveation = s.configuration = s.updateState = s.qcomTexture = true;
    s.metaEyeTracked = s.systemEyeTracked = s.eyePermission = s.eyeGaze = true;
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
    FoveationProfileSpec spec;
    assert(!strcmp(foveationLevelName(spec), "unfoveated"));
    spec.apply = true;
    assert(!strcmp(foveationLevelName(spec), "none"));
    spec.empty = false;
    spec.level = XR_FOVEATION_LEVEL_HIGH_FB;
    assert(!strcmp(foveationLevelName(spec), "high"));
    spec.level = XR_FOVEATION_LEVEL_LOW_FB;
    assert(!strcmp(foveationLevelName(spec), "low"));
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
    // Nothing supported: full-resolution swapchains, nothing to apply, at every setting.
    FoveationPolicy none;
    assert(!none.swapchainFoveation() && !none.eyeTrackedAvailable());
    for (auto q : kQualities)
        assert(!none.desired(q).apply);

    FoveationPolicy policy(full());
    assert(policy.swapchainFoveation() && policy.eyeTrackedAvailable());
    const auto off = policy.desired(FoveationQuality::Off);
    assert(off.apply && off.empty && !off.eyeTracked && "Off is the documented empty profile");
    for (auto q :
         {FoveationQuality::Clarity, FoveationQuality::Balanced, FoveationQuality::Performance}) {
        const auto spec = policy.desired(q);
        assert(spec.apply && !spec.empty && spec.eyeTracked && spec.level == foveationLevel(q));
    }
    assert(*policy.fallback() == 0);

    auto denied = full();
    denied.eyePermission = false;
    const auto fixed = FoveationPolicy(denied).desired(FoveationQuality::Balanced);
    assert(fixed.apply && !fixed.empty && !fixed.eyeTracked &&
           fixed.level == XR_FOVEATION_LEVEL_MEDIUM_FB && "refused permission keeps fixed levels");
    assert(fixed != policy.desired(FoveationQuality::Balanced));
}

void degrade() {
    FoveationPolicy policy(full());
    const auto eye = policy.desired(FoveationQuality::Performance);
    assert(policy.rejected(eye));
    assert(!policy.eyeTrackedAvailable() && *policy.fallback());
    const auto fixed = policy.desired(FoveationQuality::Performance);
    assert(fixed.apply && !fixed.empty && !fixed.eyeTracked &&
           fixed.level == XR_FOVEATION_LEVEL_HIGH_FB);
    assert(policy.rejected(fixed));
    for (auto q : kQualities) {
        const auto spec = policy.desired(q);
        assert(spec.apply && spec.empty && "levels rejected: every setting is unfoveated");
    }
    assert(!policy.rejected(policy.desired(FoveationQuality::Balanced)));
    assert(!policy.swapchainFoveation() && *policy.fallback());
    const std::string reason = policy.fallback();
    policy.swapchainFailed();
    assert(reason == policy.fallback() && "the first reason is kept");
    for (auto q : kQualities)
        assert(!policy.desired(q).apply && "the targets are recreated without foveation");
    assert(!policy.rejected(policy.desired(FoveationQuality::Balanced)));

    FoveationPolicy swapchain(full());
    swapchain.swapchainFailed();
    assert(!swapchain.swapchainFoveation() && !swapchain.desired(FoveationQuality::Balanced).apply);

    auto denied = full();
    denied.systemEyeTracked = false;
    FoveationPolicy fixedOnly(denied);
    assert(fixedOnly.rejected(fixedOnly.desired(FoveationQuality::Clarity)));
    assert(fixedOnly.desired(FoveationQuality::Clarity).empty);
}

void eyeTrackedFrames() {
    FoveationPolicy policy(full());
    assert(!policy.eyeTrackedFrame(XR_SUCCESS, XR_SUCCESS));
    assert(policy.eyeTrackedAvailable());
    for (int i = 1; i < FoveationPolicy::kStateFailureLimit; ++i)
        assert(!policy.eyeTrackedFrame(XR_SUCCESS, XR_ERROR_RUNTIME_FAILURE));
    assert(!policy.eyeTrackedFrame(XR_SUCCESS, XR_SUCCESS) && "a success resets the count");
    for (int i = 1; i < FoveationPolicy::kStateFailureLimit; ++i)
        assert(!policy.eyeTrackedFrame(XR_SUCCESS, XR_ERROR_RUNTIME_FAILURE));
    assert(policy.eyeTrackedFrame(XR_SUCCESS, XR_ERROR_RUNTIME_FAILURE));
    assert(!policy.eyeTrackedAvailable() && !policy.desired(FoveationQuality::Balanced).eyeTracked);
    assert(!policy.eyeTrackedFrame(XR_SUCCESS, XR_ERROR_RUNTIME_FAILURE) && "reported once");

    FoveationPolicy unsupported(full());
    assert(unsupported.eyeTrackedFrame(XR_SUCCESS, XR_ERROR_FEATURE_UNSUPPORTED));
    assert(unsupported.desired(FoveationQuality::Balanced).level == XR_FOVEATION_LEVEL_MEDIUM_FB);

    FoveationPolicy update(full());
    assert(update.eyeTrackedFrame(XR_ERROR_HANDLE_INVALID, XR_SUCCESS));
    assert(!update.desired(FoveationQuality::Clarity).eyeTracked &&
           update.desired(FoveationQuality::Clarity).apply);
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
    }
}
} // namespace

int main() {
    levels();
    capabilities();
    plans();
    degrade();
    eyeTrackedFrames();
    samples();
    overlay();
    std::cout << "runtime foveation levels, fallbacks, eye-tracked results and overlay checks "
                 "passed\n";
}
