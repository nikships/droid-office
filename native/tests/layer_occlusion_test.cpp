// The player's hands in front of the compositor quads (layer_occlusion.h): the workspace panel's
// hole in the world layer, and the status card yielding to a hand in front of it.
#include "layer_occlusion.h"

#include <cassert>
#include <cmath>
#include <cstdio>

using namespace office;
namespace {
constexpr float pi = 3.14159265358979323846f;

bool close(float a, float b, float tolerance = 1e-4f) { return std::abs(a - b) < tolerance; }
bool close(XrVector3f a, XrVector3f b, float tolerance = 1e-4f) {
    return close(a.x, b.x, tolerance) && close(a.y, b.y, tolerance) && close(a.z, b.z, tolerance);
}
XrQuaternionf axisAngle(XrVector3f axis, float angle) {
    const float s = std::sin(angle / 2);
    return {axis.x * s, axis.y * s, axis.z * s, std::cos(angle / 2)};
}

/** The hole is the panel quad, inset, in the order a triangle strip needs, wherever it stands. */
void panelHoleMatchesThePanel() {
    // As office_xr.cpp places it: 1.5 m ahead of the head, 0.1 m below the eyes, facing the head.
    const XrPosef ahead{{0, 0, 0, 1}, {0, 1.5f, -1.5f}};
    const auto c = panelCutoutCorners(ahead, kPanelWidth, kPanelHeight, .004f);
    assert(close(c[0], {-.896f, .904f, -1.5f}) && close(c[1], {.896f, .904f, -1.5f}));
    assert(close(c[2], {-.896f, 2.096f, -1.5f}) && close(c[3], {.896f, 2.096f, -1.5f}));
    // Turned and moved: the corners land where panelHit finds the panel's own corners.
    const XrPosef turned{axisAngle({0, 1, 0}, pi / 3), {2, 1.4f, -1}};
    const auto t = panelCutoutCorners(turned, kPanelWidth, kPanelHeight, 0);
    const float expect[4][2] = {{0, 1}, {1, 1}, {0, 0}, {1, 0}}; // panelHit x right, y down
    const XrVector3f eye = add(turned.position, rotate(turned.orientation, {0, 0, 1.5f}));
    for (int i = 0; i < 4; i++) {
        const auto to = subtract(t[size_t(i)], eye);
        const float length = std::sqrt(to.x * to.x + to.y * to.y + to.z * to.z);
        const auto dir = scale(to, 1 / length);
        // A ray whose -Z is `dir`: rotate -Z onto it.
        const XrVector3f z{0, 0, -1};
        const XrVector3f axis{z.y * dir.z - z.z * dir.y, z.z * dir.x - z.x * dir.z,
                              z.x * dir.y - z.y * dir.x};
        const float sine = std::sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
        const float angle = std::atan2(sine, z.x * dir.x + z.y * dir.y + z.z * dir.z);
        const XrPosef ray{axisAngle(scale(axis, 1 / sine), angle), eye};
        float x = -1, y = -1, distance = 0;
        panelHit(ray, turned, kPanelWidth + .01f, kPanelHeight + .01f, x, y, distance);
        assert(close(distance, length, 1e-3f));
        assert(close(x, .5f + (expect[i][0] - .5f) * kPanelWidth / (kPanelWidth + .01f), 1e-3f));
        assert(close(y, .5f + (expect[i][1] - .5f) * kPanelHeight / (kPanelHeight + .01f), 1e-3f));
    }
    // An inset never turns the hole inside out.
    const auto tiny = panelCutoutCorners(ahead, .002f, .002f, .004f);
    assert(close(tiny[0], tiny[3]));
}

InputFrame oneHand(int h, XrVector3f grip) {
    InputFrame frame;
    auto &hand = frame.hands[size_t(h)];
    hand.active = hand.gripTracked = true;
    hand.grip = hand.aim = {{0, 0, 0, 1}, grip};
    return frame;
}

/** Whether the controllers drawn for `frame` (none hidden) cover the card. */
bool controllersCover(XrPosef head, const InputFrame &frame, unsigned hidden = 0) {
    HandBall balls[2];
    const size_t count = controllerBalls(frame, hidden, balls);
    return handsCoverStatus(head, balls, count);
}

/** The status card (0.9 x 0.169 m, 1.4 m ahead, 0.4 m below the eyes) yields only to what is
 * really in front of it from where the eyes are. */
void statusYieldsToHands() {
    const XrPosef head{{0, 0, 0, 1}, {0, 1.6f, 0}};
    // A controller straight in front of the card, at arm's length.
    assert(controllersCover(head, oneHand(1, {0, 1.6f - .2f, -.7f})));
    // Untracked, only aim-tracked, or hidden because it holds the gun: not drawn, covers nothing.
    auto lost = oneHand(1, {0, 1.4f, -.7f});
    assert(!controllersCover(head, lost, 2));
    assert(controllersCover(head, lost, 1)); // the other hand's bit
    lost.hands[1].gripTracked = false;
    assert(!controllersCover(head, lost));
    lost.hands[1].gripTracked = true;
    lost.hands[1].active = false;
    assert(!controllersCover(head, lost));
    // Relaxed low and to the side, or holding the gun at the draw pose: clear of the card.
    assert(!controllersCover(head, oneHand(0, {-.2f, 1.6f - .45f, -.3f})));
    assert(!controllersCover(head, oneHand(1, {.15f, 1.6f - .2f, -.35f})));
    // Just past the card's corner: the ball's outline, not its bounding box, decides.
    const float s = .35f / 1.4f; // the card's corner seen from 0.35 m
    const XrVector3f corner{.45f * s, 1.6f - .484f * s, -.35f};
    const float off = (kControllerRadius + .01f) / std::sqrt(2.f);
    assert(!controllersCover(head, oneHand(1, {corner.x + off, corner.y - off, corner.z})));
    assert(
        controllersCover(head, oneHand(1, {corner.x + .5f * off, corner.y - .5f * off, corner.z})));
    // Raised high (an elevator key at eye height): above the card.
    assert(!controllersCover(head, oneHand(1, {0, 1.6f, -.5f})));
    // Beside or behind the eyes, or beyond the card: never in front of it.
    assert(!controllersCover(head, oneHand(1, {.3f, 1.6f, .02f})));
    assert(!controllersCover(head, oneHand(1, {0, 1.6f - .6f, -2.2f})));
    // What the hand holds counts by its own bounds: a gun part over the card covers it, a part
    // beside it does not, and empty or infinite bounds are ignored.
    const HandBall barrel{{.1f, 1.6f - .17f, -.6f}, .05f}, beside{{.4f, 1.6f - .1f, -.6f}, .05f};
    assert(handsCoverStatus(head, &barrel, 1));
    assert(!handsCoverStatus(head, &beside, 1));
    const HandBall odd[2] = {{{0, 1.4f, -.7f}, -1}, {{0, 1.4f, -.7f}, INFINITY}};
    assert(!handsCoverStatus(head, odd, 2));
    // The head turned and moved: the same rule in its own view.
    const XrPosef turned{axisAngle({0, 1, 0}, pi / 2), {3, 1.7f, 1}};
    const auto inFront = add(turned.position, rotate(turned.orientation, {0, -.2f, -.7f}));
    assert(controllersCover(turned, oneHand(0, inFront)));
    assert(!controllersCover(turned, oneHand(0, {0, 1.5f, -.7f})));
}

/** The card fades out quickly while covered and back in once clear, per display period. */
void statusFades() {
    StatusYield yield;
    assert(close(yield.value(), 1));
    const float period = 1 / 90.f;
    int frames = 0;
    while (yield.step(true, period) > 0)
        frames++;
    assert(frames >= 8 && frames <= 9); // 0.1 s at 90 Hz
    assert(close(yield.step(true, period), 0));
    frames = 0;
    while (yield.step(false, period) < 1)
        frames++;
    assert(frames >= 21 && frames <= 23); // 0.25 s at 90 Hz
    // A long stall does not skip the fade in one jump, and a negative period changes nothing.
    yield.step(true, 5);
    assert(yield.value() > 0);
    const float before = yield.value();
    assert(close(yield.step(true, -1), before));
    yield.reset();
    assert(close(yield.value(), 1));
}
} // namespace

int main() {
    panelHoleMatchesThePanel();
    statusYieldsToHands();
    statusFades();
    std::puts("layer occlusion tests passed");
}
