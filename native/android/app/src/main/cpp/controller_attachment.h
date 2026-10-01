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
 * about every 33 ms, but on the headset its packets regularly arrive 250-500 ms apart while it
 * works, and a held gun must not blink out of the hand while the page catches up. Dropping does
 * not wait for the page: a grip-held object hides on the display frame its squeeze is released
 * (held), tracking loss hides it at once, and a navigating page resets the controls. Only a page
 * that stopped answering for this long loses what it attached.
 */
constexpr int64_t kAttachmentStaleNs = 1'500'000'000;

/**
 * Squeeze at or above this holds a grip-held attachment: the page's SQUEEZE_OFF, below which its
 * grab latch releases, so the native drop lands on the same sample as the page's.
 */
constexpr float kGripHeldSqueeze = 0.6f;

/**
 * grip[h] = rig * the current tracked grip pose, the same transform the native controller model
 * is drawn with. Invalid unless the session is focused and rendering, the control snapshot is
 * fresh and active, and hand h is active with a tracked grip; the renderer then hides hand h's
 * attached objects instead of drawing an older pose. held[h] additionally needs hand h's squeeze
 * at kGripHeldSqueeze or more, for objects that are only carried while the grip is squeezed.
 */
inline SceneControllerPoses attachmentPoses(const InputFrame &input, const Matrix &rig,
                                            const AttachmentFrame &frame) {
    SceneControllerPoses out;
    const int64_t age = frame.nowNs - frame.receivedNs;
    const bool fresh = frame.receivedNs > 0 && age >= -1'000'000 && age <= kAttachmentStaleNs;
    const bool usable =
        frame.focused && frame.poseValid && frame.shouldRender && frame.controlsActive && fresh;
    for (int h = 0; h < 2; h++) {
        const auto &hand = input.hands[size_t(h)];
        out.valid[h] = usable && hand.active && hand.gripTracked;
        if (!out.valid[h])
            continue;
        out.held[h] = hand.squeeze >= kGripHeldSqueeze;
        const Matrix world = multiply(rig, transform(hand.grip));
        std::copy(world.begin(), world.end(), out.grip[h]);
    }
    return out;
}

} // namespace office
