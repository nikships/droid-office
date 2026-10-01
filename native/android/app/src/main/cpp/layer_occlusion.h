// The workspace panel and the status card are compositor quads: the compositor draws them over or
// under the world layer as a whole, never depth-tested against the player's controllers, rays or
// held gun. These are the display loop's rules that keep the player's own hands in front of them.
// Header-only and GL-free for the host tests.
#pragma once
#include "xr_input.h"
#include "xr_math.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace office {

/** The workspace panel quad's size in metres (office_xr.cpp). */
constexpr float kPanelWidth = 1.8f, kPanelHeight = 1.2f;

/**
 * The hole PanelCutout cuts into the world layer for the panel at `panel` (a quad in its local
 * XY plane, facing +Z): its corners `inset` inside the edges, in the panel pose's space, as
 * bottom-left, bottom-right, top-left, top-right (a triangle strip).
 */
inline std::array<XrVector3f, 4> panelCutoutCorners(XrPosef panel, float width, float height,
                                                    float inset) {
    const float x = std::max(0.f, width / 2 - inset), y = std::max(0.f, height / 2 - inset);
    auto at = [&](float u, float v) {
        return add(panel.position, rotate(panel.orientation, {u, v, 0}));
    };
    return {at(-x, -y), at(x, -y), at(-x, y), at(x, y)};
}

/** The status card's quad in VIEW space, as office_xr.cpp submits it. */
struct StatusQuad {
    XrVector3f center{0, -.4f, -1.4f};
    float width = .9f, height = .16875f;
};

/** A bounding ball of something the player holds up, in LOCAL_FLOOR. */
struct HandBall {
    XrVector3f center{};
    float radius = 0;
};

/** The Samsung controller model around its grip, for status occlusion. */
constexpr float kControllerRadius = .07f;

/**
 * The controllers the display loop draws (active, with a tracked grip, not hidden because the
 * hand holds the gun) as balls around their grips. Returns how many it wrote to `out`.
 */
inline size_t controllerBalls(const InputFrame &frame, unsigned hidden, HandBall out[2]) {
    size_t count = 0;
    for (int h = 0; h < 2; h++) {
        const auto &hand = frame.hands[size_t(h)];
        if (hand.active && hand.gripTracked && !(hidden & (1u << h)))
            out[count++] = {hand.grip.position, kControllerRadius};
    }
    return count;
}

/**
 * Whether any ball (the controllers, and the bounding spheres of what they hold) lies between the
 * eyes and the status quad: projected from the head onto the quad's plane, its outline overlaps
 * the quad. `head` is this display frame's head pose in the balls' space (LOCAL_FLOOR).
 */
inline bool handsCoverStatus(XrPosef head, const HandBall *balls, size_t count,
                             const StatusQuad &quad = {}) {
    const float depth = -quad.center.z;
    if (depth <= 0)
        return false;
    const auto toView = conjugate(head.orientation);
    for (size_t i = 0; i < count; i++) {
        const float radius = balls[i].radius;
        if (!(radius >= 0) || std::isinf(radius))
            continue;
        const auto v = rotate(toView, subtract(balls[i].center, head.position));
        const float ahead = -v.z;
        // Beside or behind the eyes, or beyond the card: it cannot be in front of the card.
        if (ahead < .05f || ahead - radius > depth)
            continue;
        // The ball's outline on the card's plane, against the card's rectangle.
        const float s = depth / ahead, r = radius * s;
        const float dx = std::max(0.f, std::abs(v.x * s - quad.center.x) - quad.width / 2);
        const float dy = std::max(0.f, std::abs(v.y * s - quad.center.y) - quad.height / 2);
        if (dx * dx + dy * dy < r * r)
            return true;
    }
    return false;
}

/**
 * The status card's opacity: it fades out while the player's hand is in front of it and back in
 * once the hand has left, instead of being drawn over the hand. The layer is still submitted every
 * frame at opacity 0, so its Surface keeps being consumed (native/AGENTS.md).
 */
class StatusYield {
  public:
    static constexpr float kOutSeconds = .1f, kInSeconds = .25f;
    /** Advances by `seconds` (a display period) and returns the opacity for this frame. */
    float step(bool covered, float seconds) {
        seconds = std::clamp(seconds, 0.f, .05f); // one display frame, even after a stall
        opacity = covered ? std::max(0.f, opacity - seconds / kOutSeconds)
                          : std::min(1.f, opacity + seconds / kInSeconds);
        return opacity;
    }
    float value() const { return opacity; }
    void reset() { opacity = 1; }

  private:
    float opacity = 1;
};

} // namespace office
