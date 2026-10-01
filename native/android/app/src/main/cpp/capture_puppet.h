// Debug-only capture puppet: synthetic motion controllers for headless captures.
//
// Physical controllers are not tracked while nobody holds them, so a headset lying on a desk
// shows no controllers, no held gun and no hands on buttons. In a debug build the page may send
// a puppet with its control packet (bridge_state.cpp); the display loop then fills each
// controller slot the runtime reports as untracked with the puppet hand, before anything reads
// the frame. Controller models, rays, button animation, attachments (the held gun, carried
// cards), the panel pointer and the page's input samples all see it as a tracked controller,
// so every interaction runs through the real paths. A tracked controller always wins.
//
// Release builds compile without OFFICE_CAPTURE_PUPPET: kCapturePuppetBuild is false, the bridge
// never reads the field and the display loop never applies a puppet. Debug builds also need the
// Java host's BuildConfig.DEBUG (capturePuppetEnabled). Header-only and GL-free for host tests.
#pragma once
#include "xr_input.h"
#include "xr_math.h"

#include <array>
#include <cmath>
#include <cstdint>

namespace office {

#ifdef OFFICE_CAPTURE_PUPPET
constexpr bool kCapturePuppetBuild = true;
#else
constexpr bool kCapturePuppetBuild = false;
#endif

/** The native build gate and the Java host's BuildConfig.DEBUG must both allow the puppet. */
constexpr bool capturePuppetEnabled(bool hostDebug) { return kCapturePuppetBuild && hostDebug; }

/**
 * Where a puppet hand's poses are expressed. Local is the native LOCAL_FLOOR space; Head is
 * relative to this display frame's head pose; Heading is relative to the head position and its
 * horizontal heading only (gravity up), for poses such as a back holster that ignore head pitch.
 */
enum class PuppetSpace : uint8_t { Local, Head, Heading };

struct PuppetHand {
    bool present = false;
    PuppetSpace space = PuppetSpace::Local;
    XrPosef grip{{0, 0, 0, 1}, {0, 0, 0}}, aim{{0, 0, 0, 1}, {0, 0, 0}};
    float trigger = 0, squeeze = 0;
    XrVector2f stick{};
    bool primary = false, secondary = false, menu = false, stickClick = false;
};

struct PuppetState {
    std::array<PuppetHand, 2> hands{};
    bool active() const { return hands[0].present || hands[1].present; }
};

/**
 * Longest the page may go without refreshing the puppet. The page sends about every 33 ms; a
 * stalled or navigating page must not leave a synthetic controller behind.
 */
constexpr int64_t kPuppetStaleNs = 250'000'000;

/** Everything besides the puppet itself that decides whether this display frame may use it. */
struct PuppetFrame {
    bool enabled = false;   // capturePuppetEnabled(): debug native build and debug Java host
    bool tracking = false;  // focused, with both eye poses located this frame
    int64_t nowNs = 0;      // steady clock, as ControlState::receivedNs
    int64_t receivedNs = 0; // when the control packet carrying the puppet arrived
    XrPosef head{{0, 0, 0, 1}, {0, 0, 0}};
};

/** The head position with only its horizontal heading. Looking straight up or down keeps a heading.
 */
inline XrPosef headingPose(XrPosef head) {
    auto forward = rotate(head.orientation, {0, 0, -1});
    if (forward.x * forward.x + forward.z * forward.z < .0025f) {
        // The head's up vector points forward when looking down and backward when looking up.
        const auto up = rotate(head.orientation, {0, 1, 0});
        forward = forward.y < 0 ? up : scale(up, -1);
    }
    return {yaw(std::atan2(-forward.x, -forward.z)), head.position};
}

inline XrPosef puppetPose(PuppetSpace space, XrPosef pose, XrPosef head) {
    switch (space) {
    case PuppetSpace::Head:
        return compose(head, pose);
    case PuppetSpace::Heading:
        return compose(headingPose(head), pose);
    case PuppetSpace::Local:
        break;
    }
    return pose;
}

/**
 * Fills untracked controller slots of this display frame with the puppet. Returns a bit per slot
 * the puppet drives (1 left, 2 right). Nothing changes unless the puppet is enabled, the session
 * is tracking and the puppet is fresh; a slot whose controller is active with a tracked grip keeps
 * the real controller. A puppet hand is a tracked controller with a tracked grip, marked puppet.
 */
inline unsigned applyPuppet(InputFrame &frame, const PuppetState &puppet, const PuppetFrame &at) {
    if (!at.enabled || !at.tracking || !puppet.active())
        return 0;
    const int64_t age = at.nowNs - at.receivedNs;
    if (at.receivedNs <= 0 || age < -1'000'000 || age > kPuppetStaleNs)
        return 0;
    unsigned driven = 0;
    for (int h = 0; h < 2; h++) {
        const auto &p = puppet.hands[size_t(h)];
        auto &hand = frame.hands[size_t(h)];
        if (!p.present || (hand.active && hand.gripTracked))
            continue;
        HandInput next;
        next.active = true;
        next.gripTracked = true;
        next.puppet = true;
        next.grip = puppetPose(p.space, p.grip, at.head);
        next.aim = puppetPose(p.space, p.aim, at.head);
        next.trigger = p.trigger;
        next.squeeze = p.squeeze;
        next.stick = p.stick;
        next.primary = p.primary;
        next.secondary = p.secondary;
        next.menu = p.menu;
        next.stickClick = p.stickClick;
        hand = next;
        driven |= 1u << h;
    }
    return driven;
}

} // namespace office
