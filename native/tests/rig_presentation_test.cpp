#include "rig_presentation.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

using namespace office;
namespace {
constexpr double interval = 1000. / 30.;
constexpr float pi = 3.14159265358979323846f;
bool close(float a, float b, float tolerance = .0001f) { return std::abs(a - b) < tolerance; }
ControlState sample(uint64_t revision, double receivedMs, float x = 0, float angle = 0,
                    uint32_t epoch = 0, float fade = 0) {
    ControlState result;
    result.active = true;
    result.revision = revision;
    result.receivedNs = static_cast<int64_t>(std::llround(receivedMs * 1e6));
    result.rig = transform({yaw(angle), {x, 0, 0}});
    result.presentationEpoch = epoch;
    result.fade = fade;
    return result;
}
ControlState presented(RigPresentation &presentation, const ControlState &source, double now,
                       bool focused = true) {
    auto result = source;
    presentation.present(result, now, focused);
    return result;
}
float angle(const Matrix &rig) { return std::atan2(rig[8], rig[0]); }
void proper(const Matrix &rig) {
    for (float value : rig)
        assert(std::isfinite(value));
    auto identity = multiply(inverseRigid(rig), rig);
    for (int i = 0; i < 16; i++)
        assert(close(identity[i], i % 5 == 0 ? 1.f : 0.f));
    float determinant = rig[0] * (rig[5] * rig[10] - rig[6] * rig[9]) -
                        rig[4] * (rig[1] * rig[10] - rig[2] * rig[9]) +
                        rig[8] * (rig[1] * rig[6] - rig[2] * rig[5]);
    assert(close(determinant, 1.f));
}
void constantMotion() {
    RigPresentation presentation;
    ControlState current;
    float previousX = 0;
    for (int frame = 0; frame <= 90; frame++) {
        const double elapsed = frame * 1000. / 90.;
        if (frame % 3 == 0)
            current = sample(frame / 3 + 1, 1000 + elapsed, elapsed * .002, elapsed * .0005);
        auto result = presented(presentation, current, 1000 + elapsed);
        proper(result.rig);
        // Once the first complete interval arrives, motion advances every display,
        // exactly one bridge interval behind. It never leads the authoritative rig.
        if (frame >= 3) {
            const float expected = static_cast<float>(elapsed - interval);
            assert(close(result.rig[12], expected * .002f));
            assert(close(angle(result.rig), expected * .0005f));
            if (frame > 3)
                assert(result.rig[12] > previousX);
        }
        assert(result.rig[12] <= current.rig[12] + .00001f);
        previousX = result.rig[12];
    }
    const auto endpoint = presented(presentation, current, 1050 + 1000);
    assert(close(endpoint.rig[12], current.rig[12]));
    const auto stale = presented(presentation, current, 5000);
    assert(close(stale.rig[12], current.rig[12])); // No continued movement or extrapolation.
}
void independentDisplayRateAndRotationWrap() {
    RigPresentation direct, manyFrames;
    auto first = sample(1, 1000, 0, 179 * pi / 180);
    auto next = sample(2, 1000 + interval, .1f, -179 * pi / 180);
    presented(direct, first, 1000);
    presented(manyFrames, first, 1000);
    presented(direct, next, 1000 + interval);
    presented(manyFrames, next, 1000 + interval);
    for (int i = 1; i < 20; i++)
        presented(manyFrames, next, 1000 + interval + interval * i / 40.);
    auto a = presented(direct, next, 1000 + interval * 1.5);
    auto b = presented(manyFrames, next, 1000 + interval * 1.5);
    for (int i = 0; i < 16; i++)
        assert(close(a.rig[i], b.rig[i]));
    assert(close(a.rig[12], .05f));
    assert(std::abs(std::abs(angle(a.rig)) - pi) < .0001f);
    proper(a.rig);

    // All matrix-to-quaternion branches and pitch/roll remain proper rotations.
    for (auto q : {XrQuaternionf{1, 0, 0, 0}, XrQuaternionf{0, 1, 0, 0}, XrQuaternionf{0, 0, 1, 0},
                   multiply(yaw(.3f), {.19866933f, 0, 0, .98006658f})}) {
        RigPresentation rotation;
        auto source = sample(1, 1000);
        source.rig = transform({q, {2, 3, 4}});
        const auto result = presented(rotation, source, 1000);
        for (int i = 0; i < 16; i++)
            assert(close(result.rig[i], source.rig[i]));
        proper(result.rig);
    }
}
void discontinuitiesAndLegacyGuards() {
    RigPresentation presentation;
    auto source = sample(1, 1000);
    presented(presentation, source, 1000);
    // A tiny teleport cannot be identified by a distance threshold: epoch is decisive.
    source = sample(2, 1000 + interval, .02f, 0, 1);
    auto result = presented(presentation, source, 1000 + interval);
    assert(close(result.rig[12], .02f));
    source = sample(3, 1000 + interval * 2, .02f, pi / 4, 2);
    result = presented(presentation, source, 1000 + interval * 2);
    assert(close(angle(result.rig), pi / 4));
    // Explicit epochs also preserve smaller future snap settings.
    source = sample(4, 1100, .02f, pi / 4 + .02f, 3);
    result = presented(presentation, source, 1100);
    assert(close(angle(result.rig), pi / 4 + .02f));

    RigPresentation legacy;
    presented(legacy, sample(1, 1000), 1000);
    result = presented(legacy, sample(2, 1000 + interval, 0, pi / 4), 1000 + interval);
    assert(close(angle(result.rig), pi / 4));
    result = presented(legacy, sample(3, 1000 + interval * 2, 10, pi / 4), 1000 + interval * 2);
    assert(close(result.rig[12], 10));
    // A stream/reset revision moving backward must not blend the old session into the new.
    result = presented(legacy, sample(1, 1100, 10.1f, pi / 4), 1100);
    assert(close(result.rig[12], 10.1f));
}
void staleFocusAndReset() {
    RigPresentation presentation;
    auto first = sample(1, 1000), next = sample(2, 1000 + interval, .1f);
    presented(presentation, first, 1000);
    presented(presentation, next, 1000 + interval);
    auto result = presented(presentation, next, 1050);
    assert(close(result.rig[12], .05f));
    result = presented(presentation, next, 1150);
    assert(close(result.rig[12], .1f));
    next = sample(3, 1160, .2f);
    result = presented(presentation, next, 1160);
    assert(close(result.rig[12], .2f)); // Recovery establishes a baseline, not a delayed move.
    next = sample(4, 1160 + interval, .3f);
    result = presented(presentation, next, 1160 + interval, false);
    assert(close(result.rig[12], .3f));
    next = sample(5, 1160 + interval * 2, .4f);
    result = presented(presentation, next, 1160 + interval * 2);
    assert(close(result.rig[12], .4f));
    presentation.reset(); // Native reference-space change/recenter.
    next = sample(6, 1260, .45f);
    result = presented(presentation, next, 1260);
    assert(close(result.rig[12], .45f));
    next = sample(7, 1290, .5f);
    next.active = false;
    result = presented(presentation, next, 1290);
    assert(close(result.rig[12], .5f));
    next = sample(8, 1320, .55f);
    result = presented(presentation, next, 1320);
    assert(close(result.rig[12], .55f));
    // Clock reversal also invalidates a transition. No amount is integrated per frame.
    next = sample(9, 1310, .56f);
    result = presented(presentation, next, 1310);
    assert(close(result.rig[12], .56f));
}
void fadeAndWorldHints() {
    RigPresentation presentation;
    auto first = sample(1, 1000), next = sample(2, 1000 + interval, 0, 0, 0, .4f);
    presented(presentation, first, 1000);
    presented(presentation, next, 1000 + interval);
    auto result = presented(presentation, next, 1000 + interval * 1.5);
    assert(close(result.fade, .2f));
    next = sample(3, 1000 + interval * 2, .03f, 0, 1, 1);
    result = presented(presentation, next, 1000 + interval * 2);
    assert(result.fade == 1 && close(result.rig[12], .03f));
    next = sample(4, 1100, .03f, 0, 1, .5f);
    next.hands[1] = {true, true, false, {2, 1, 3}};
    next.arc = {{2, 0, 4}, {2, 0, 5}};
    next.marker = {2, 0, 5};
    next.teleportValid = true;
    presented(presentation, next, 1100);
    result = presented(presentation, next, 1100 + interval * .5);
    assert(close(result.fade, .75f));
    assert(result.hands[1].valid && result.hands[1].near && result.hands[1].point.x == 2);
    assert(result.arc.size() == 2 && result.arc[1].z == 5 && result.marker.z == 5);
    // InputRenderer's existing world-to-presented-rig transform keeps the hit anchored
    // in the same world shown by the eyes; local tracked hands are not interpolated here.
    const auto localHit = transformPoint(inverseRigid(result.rig), result.hands[1].point);
    const auto worldHit = transformPoint(result.rig, localHit);
    assert(close(worldHit.x, 2) && close(worldHit.y, 1) && close(worldHit.z, 3));
    next = sample(5, 1100 + interval, .03f, 0, 1, 0);
    presented(presentation, next, 1100 + interval);
    result = presented(presentation, next, 1100 + interval * 2);
    assert(result.fade == 0);
}
void invalidRigAndFade() {
    RigPresentation presentation;
    auto source = sample(1, 1000, .2f);
    presented(presentation, source, 1000);
    for (int invalid = 0; invalid < 4; invalid++) {
        auto broken = sample(2, 1000 + interval, .3f);
        if (invalid == 0)
            broken.rig[0] = 2;
        else if (invalid == 1)
            broken.rig[0] = -1;
        else if (invalid == 2)
            broken.rig[4] = .1f;
        else
            broken.rig[12] = std::numeric_limits<float>::infinity();
        auto result = presented(presentation, broken, 1000 + interval);
        proper(result.rig);
        assert(close(result.rig[12], .2f));
    }
    source = sample(3, 1100, .4f);
    source.fade = std::numeric_limits<float>::quiet_NaN();
    auto result = presented(presentation, source, 1100);
    assert(result.fade == 0 && close(result.rig[12], .4f));
    result = presented(presentation, source, std::numeric_limits<double>::quiet_NaN());
    proper(result.rig);
}
} // namespace
int main() {
    constantMotion();
    independentDisplayRateAndRotationWrap();
    discontinuitiesAndLegacyGuards();
    staleFocusAndReset();
    fadeAndWorldHints();
    invalidRigAndFade();
    std::cout
        << "Native rig/fade interpolation, discontinuity, stale and proper-rotation tests passed\n";
}
