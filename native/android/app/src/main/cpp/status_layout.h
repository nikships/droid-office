// Where the closed-workspace status Surface is shown: the FPS counter, small and faint at the
// lower-left edge of the view, and each toast in a card below the line of sight. Header-only
// and GL-free so the host tests check the device values.
#pragma once
#include "xr_input.h"
#include "xr_math.h"

#include <array>
#include <cmath>
#include <limits>
#include <utility>

namespace office::status {
constexpr float kDegrees = 3.14159265358979323846f / 180;

// One Android Surface holds both parts side by side. Each quad shows its own full-height column,
// so the split never depends on the image's vertical origin, and a transparent gutter keeps
// texture filtering from bleeding one column into the other.
constexpr int kWidth = 1536, kHeight = 192;
constexpr int kMessageWidth = 1024;
constexpr int kCounterLeft = 1040;
constexpr int kCounterWidth = kWidth - kCounterLeft;

// The toast card, 1.4 m ahead and 0.4 m (about 16 degrees) below the eyes.
constexpr XrPosef kMessagePose{{0, 0, 0, 1}, {0, -.4f, -1.4f}};
constexpr XrExtent2Df kMessageSize{.9f, .16875f};

// The counter column faces the eyes from this direction and distance. Its text starts at the
// column's left edge, about 31 degrees left of the line of sight, on a line 27 degrees below it:
// at the lower-left edge of the view, well clear of the centre, where a worker's face sits when
// the player looks at it.
constexpr float kCounterYaw = 24 * kDegrees; // positive turns left
constexpr float kCounterPitch = -27 * kDegrees;
constexpr float kCounterDistance = 1.4f;
// 0.611 mm per pixel at 1.4 m: the panel's 28 px text is 0.7 degrees tall, Android XR's 14 dp
// minimum, against 1.0 degree for the toast card.
constexpr float kCounterMetresPerPixel = .000611f;
constexpr float kCounterWidthMetres = kCounterMetresPerPixel * kCounterWidth;
constexpr float kCounterHeightMetres = kCounterMetresPerPixel * kHeight;
constexpr XrExtent2Df kCounterSize{kCounterWidthMetres, kCounterHeightMetres};

inline XrPosef counterPose() {
    const XrQuaternionf pitch{std::sin(kCounterPitch / 2), 0, 0, std::cos(kCounterPitch / 2)};
    const auto orientation = multiply(yaw(kCounterYaw), pitch);
    return {orientation, rotate(orientation, {0, 0, -kCounterDistance})};
}

// A controller and anything it holds count as this far around its grip and aim origins.
constexpr float kHandRadius = .1f;
// The counter comes back this long after the last frame a controller covered it.
constexpr double kRevealSeconds = .3;

/**
 * True when a tracked controller is in front of the counter column as seen from the head. The
 * head and the hands are in the same space. Head-locked layers are composited over the world,
 * so text would otherwise be drawn across the player's own hand.
 */
inline bool counterCovered(XrPosef head, const std::array<HandInput, 2> &hands) {
    const auto toHead = conjugate(head.orientation);
    const float halfYaw =
        std::atan2(kCounterSize.width / 2, kCounterDistance * std::cos(kCounterPitch));
    const float halfPitch = std::atan2(kCounterSize.height / 2, kCounterDistance);
    for (const auto &hand : hands) {
        if (!hand.active)
            continue;
        const std::array<std::pair<bool, XrVector3f>, 2> origins{
            {{true, hand.aim.position}, {hand.gripTracked, hand.grip.position}}};
        for (const auto &[tracked, origin] : origins) {
            if (!tracked)
                continue;
            const auto p = rotate(toHead, subtract(origin, head.position));
            if (p.z > -.02f) // beside or behind the eyes
                continue;
            const float distance = std::sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
            const float reach = std::atan2(kHandRadius, distance);
            const float yawToHand = std::atan2(-p.x, -p.z);
            const float pitchToHand = std::atan2(p.y, std::sqrt(p.x * p.x + p.z * p.z));
            if (std::abs(yawToHand - kCounterYaw) <= halfYaw + reach &&
                std::abs(pitchToHand - kCounterPitch) <= halfPitch + reach)
                return true;
        }
    }
    return false;
}

/** Hides the counter at once while a controller covers it, and shows it kRevealSeconds later. */
class CounterReveal {
  public:
    bool visible(bool covered, double seconds) {
        if (covered)
            coveredAt = seconds;
        return !covered && !(seconds - coveredAt < kRevealSeconds);
    }

  private:
    double coveredAt = -std::numeric_limits<double>::infinity();
};

struct Layers {
    bool counter = false, message = false;
};

/**
 * Which columns to composite this frame. While the Surface producer runs, at least one layer
 * must reference its swapchain so the runtime keeps consuming the BufferQueue (native/AGENTS.md).
 * The toast column, transparent without a toast, does that alone while the counter is off or
 * covered and while the workspace is open, which keeps that frame within six layers.
 */
inline Layers layers(bool producerVisible, bool panelOpen, bool counterText, bool messageText,
                     bool counterClear) {
    Layers out;
    if (!producerVisible)
        return out;
    out.counter = !panelOpen && counterText && counterClear;
    out.message = !out.counter || messageText;
    return out;
}
} // namespace office::status
