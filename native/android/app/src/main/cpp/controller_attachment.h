// The display frame's controller grips for scene objects the page attaches to them. Header-only
// and GL-free so the host tests use the device code. See scene_renderer.h SceneControllerPoses.
#pragma once
#include "scene_renderer.h"
#include "xr_input.h"
#include "xr_math.h"

#include <algorithm>
#include <cstdint>

namespace office {

/** Everything besides the hands that decides whether this frame may place attached objects. */
struct AttachmentFrame {
    bool focused = false;
    bool poseValid = false; // both eye poses located this frame
    bool shouldRender = false;
    bool controlsActive = false; // the page's native controls own the avatar
    int64_t nowNs = 0;           // steady clock, as ControlState::receivedNs
    int64_t receivedNs = 0;      // when the rig and attachment tags were last received
};

/**
 * Longest a control snapshot may go unrefreshed and still hold an attachment. The page sends
 * about every 33 ms; a stalled page must not keep an object that it may already have dropped.
 */
constexpr int64_t kAttachmentStaleNs = 250'000'000;

namespace detail {
template <class Hand>
auto gripTracked(const Hand &hand, int) -> decltype(static_cast<bool>(hand.gripTracked)) {
    return hand.gripTracked;
}
/** An input layer without the flag reports only located controllers as active. */
template <class Hand> bool gripTracked(const Hand &, long) { return true; }
} // namespace detail

/**
 * grip[h] = rig * the current tracked grip pose, the same transform the native controller model
 * is drawn with. Invalid unless the session is focused and rendering, the control snapshot is
 * fresh and active, and hand h is active with a tracked grip; the renderer then hides hand h's
 * attached objects instead of drawing an older pose.
 */
template <class Input = InputFrame>
SceneControllerPoses attachmentPoses(const Input &input, const Matrix &rig,
                                     const AttachmentFrame &frame) {
    SceneControllerPoses out;
    const int64_t age = frame.nowNs - frame.receivedNs;
    const bool fresh = frame.receivedNs > 0 && age >= -1'000'000 && age <= kAttachmentStaleNs;
    const bool usable =
        frame.focused && frame.poseValid && frame.shouldRender && frame.controlsActive && fresh;
    for (int h = 0; h < 2; h++) {
        const auto &hand = input.hands[size_t(h)];
        out.valid[h] = usable && hand.active && detail::gripTracked(hand, 0);
        if (!out.valid[h])
            continue;
        const Matrix world = multiply(rig, transform(hand.grip));
        std::copy(world.begin(), world.end(), out.grip[h]);
    }
    return out;
}

} // namespace office
