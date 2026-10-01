// The closed-workspace status layout: the FPS counter's column, placement and size, the
// controller cover test, and which status layers a frame composites.
#include "status_layout.h"

#include <cassert>
#include <cmath>
#include <cstdio>

using namespace office;
using namespace office::status;
namespace {
constexpr float kToDegrees = 1 / kDegrees;

float length(XrVector3f v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
float dot(XrVector3f a, XrVector3f b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
// Degrees left of the line of sight (positive) and above it (negative is below).
float yawOf(XrVector3f p) { return std::atan2(-p.x, -p.z) * kToDegrees; }
float pitchOf(XrVector3f p) {
    return std::atan2(p.y, std::sqrt(p.x * p.x + p.z * p.z)) * kToDegrees;
}
float offAxis(XrVector3f p) { return std::acos(-p.z / length(p)) * kToDegrees; }

std::array<XrVector3f, 4> corners(XrPosef pose, XrExtent2Df size) {
    std::array<XrVector3f, 4> out;
    int i = 0;
    for (float x : {-.5f, .5f})
        for (float y : {-.5f, .5f})
            out[i++] =
                add(pose.position, rotate(pose.orientation, {x * size.width, y * size.height, 0}));
    return out;
}

void columns() {
    // Side by side, with a transparent gutter wider than any filter footprint.
    assert(kMessageWidth > 0 && kCounterLeft - kMessageWidth >= 8);
    assert(kCounterLeft + kCounterWidth == kWidth && kCounterWidth > 2 * 12);
    // Each quad keeps square pixels: the size follows its column's aspect.
    assert(std::abs(kMessageSize.width / kMessageWidth - kMessageSize.height / kHeight) < 1e-7f);
    assert(std::abs(kCounterSize.width / kCounterWidth - kCounterSize.height / kHeight) < 1e-7f);
}

void placement() {
    const auto pose = counterPose();
    assert(std::abs(length(pose.position) - kCounterDistance) < 1e-4f);
    // The column faces the eyes and stays level.
    const auto normal = rotate(pose.orientation, {0, 0, 1});
    assert(dot(normal, scale(pose.position, -1 / kCounterDistance)) > .9999f);
    assert(std::abs(rotate(pose.orientation, {1, 0, 0}).y) < 1e-6f);
    const auto box = corners(pose, kCounterSize);
    for (const auto &corner : box) {
        // Lower left, and well clear of the centre where a worker's face sits.
        assert(yawOf(corner) > 16 && pitchOf(corner) < -24);
        assert(offAxis(corner) > 29);
        // Still inside a single-eye headset capture, which spans about 37 degrees each way.
        assert(std::abs(corner.x / corner.z) < .74f && std::abs(corner.y / corner.z) < .74f);
    }
    // The text starts at the column's left edge, about 31 degrees left of the line of sight, on
    // a line 27 degrees below it.
    const float left = std::max(yawOf(box[0]), yawOf(box[1]));
    assert(left > 30 && left < 32);
    assert(std::abs(pitchOf(pose.position) + 27) < .01f);
    // Below the toast card, so the two never overlap.
    float toastBottom = 0;
    for (const auto &corner : corners(kMessagePose, kMessageSize))
        toastBottom = std::min(toastBottom, pitchOf(corner));
    for (const auto &corner : box)
        assert(pitchOf(corner) < toastBottom);
    // 28 px text: at least Android XR's 0.6 degree minimum, and smaller than the toast's.
    const float counterEm = std::atan2(28 * kCounterMetresPerPixel, kCounterDistance) * kToDegrees;
    const float toastEm =
        std::atan2(28 * kMessageSize.width / kMessageWidth, -kMessagePose.position.z) * kToDegrees;
    assert(counterEm >= .6f && counterEm <= .75f && counterEm < .75f * toastEm);
}

HandInput hand(XrPosef head, XrVector3f inHead, bool gripTracked = true) {
    HandInput out;
    out.active = true;
    out.gripTracked = gripTracked;
    out.grip.position = add(head.position, rotate(head.orientation, inHead));
    out.aim.position = out.grip.position;
    return out;
}

void cover() {
    // A turned head in LOCAL space: the test works in head space, not world axes.
    const XrPosef head{yaw(.7f), {.3f, 1.62f, -.4f}};
    const auto pose = counterPose();
    const auto towardCounter = scale(pose.position, .45f / kCounterDistance);
    std::array<HandInput, 2> hands{};
    assert(!counterCovered(head, hands));
    hands[0] = hand(head, towardCounter);
    assert(counterCovered(head, hands));
    // A relaxed left hand low in the view covers it too (the capture puppet's idle pose).
    hands[0] = hand(head, {-.2f, -.21f, -.42f});
    assert(counterCovered(head, hands));
    // Hands at the centre, on the right, at the hip or behind the head leave it in view.
    hands[0] = hand(head, {0, -.25f, -.4f});
    hands[1] = hand(head, {.2f, -.21f, -.42f});
    assert(!counterCovered(head, hands));
    hands[0] = hand(head, {-.25f, -.6f, -.15f});
    assert(!counterCovered(head, hands));
    hands[0] = hand(head, {-.2f, -.21f, .3f});
    assert(!counterCovered(head, hands));
    // An untracked controller covers nothing; an untracked grip falls back to the aim origin.
    hands[0] = hand(head, towardCounter);
    hands[0].active = false;
    assert(!counterCovered(head, hands));
    hands[0] = hand(head, towardCounter, false);
    hands[0].aim.position = add(head.position, rotate(head.orientation, {0, -.25f, -.4f}));
    assert(!counterCovered(head, hands));
    hands[0].gripTracked = true;
    assert(counterCovered(head, hands));
    hands[0] = HandInput{};
    hands[1] = hand(head, towardCounter);
    assert(counterCovered(head, hands));
}

void reveal() {
    CounterReveal counter;
    assert(counter.visible(false, 10));
    assert(!counter.visible(true, 11));
    assert(!counter.visible(false, 11.1));
    assert(!counter.visible(false, 11 + kRevealSeconds - .01));
    assert(counter.visible(false, 11 + kRevealSeconds + .01));
    assert(!counter.visible(true, 12));
    assert(!counter.visible(true, 13));
    assert(!counter.visible(false, 13.2));
    assert(counter.visible(false, 13.4));
}

void layering() {
    auto none = layers(false, false, true, true, true);
    assert(!none.counter && !none.message);
    auto counter = layers(true, false, true, false, true);
    assert(counter.counter && !counter.message);
    auto both = layers(true, false, true, true, true);
    assert(both.counter && both.message);
    auto toast = layers(true, false, false, true, true);
    assert(!toast.counter && toast.message);
    // A covered or switched-off counter still drains the producer through the toast column.
    auto covered = layers(true, false, true, false, false);
    assert(!covered.counter && covered.message);
    auto empty = layers(true, false, false, false, true);
    assert(!empty.counter && empty.message);
    // While the workspace is open one status layer at most, within the six-layer budget.
    for (bool counterText : {false, true})
        for (bool messageText : {false, true})
            for (bool clear : {false, true}) {
                auto open = layers(true, true, counterText, messageText, clear);
                assert(!open.counter && open.message);
            }
}
} // namespace

int main() {
    columns();
    placement();
    cover();
    reveal();
    layering();
    std::puts("Status layout, counter placement, controller cover and layer tests passed");
}
