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
    }
    assert(*policy.fallback() == 0);

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
    overlay();
    std::cout << "runtime foveation targets, fallbacks, eye-tracked results and overlay checks "
                 "passed\n";
}
