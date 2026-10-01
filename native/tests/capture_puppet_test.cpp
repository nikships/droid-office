// The debug-only capture puppet: its build and host gates, the bridge parser, and the display-frame
// merge that fills untracked controller slots. run-host.sh compiles this file twice with the
// production bridge_state.cpp: capture_puppet_debug with -DOFFICE_CAPTURE_PUPPET=1 (as the debug
// APK) and capture_puppet_release without it (as the release APK), which must ignore the puppet.
#include "bridge_state.h"
#include "capture_puppet.h"
#include "controller_attachment.h"
#include "json.hpp"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <utility>
#include <vector>

using namespace office;
using Json = nlohmann::json;

namespace {
constexpr int64_t ms = 1'000'000;

bool close(float a, float b, float tolerance = 1e-4f) { return std::abs(a - b) < tolerance; }
bool close(XrVector3f a, XrVector3f b, float tolerance = 1e-4f) {
    return close(a.x, b.x, tolerance) && close(a.y, b.y, tolerance) && close(a.z, b.z, tolerance);
}
XrQuaternionf axisAngle(XrVector3f axis, float angle) {
    const float s = std::sin(angle / 2);
    return {axis.x * s, axis.y * s, axis.z * s, std::cos(angle / 2)};
}
bool same(const HandInput &a, const HandInput &b) {
    return a.active == b.active && a.gripTracked == b.gripTracked && a.puppet == b.puppet &&
           a.trigger == b.trigger && a.squeeze == b.squeeze && a.primary == b.primary &&
           close(a.grip.position, b.grip.position) && close(a.aim.position, b.aim.position);
}

/** A control packet as the page sends it, optionally carrying a puppet. */
Json control(const Json &puppet = nullptr) {
    Json c = {{"v", 1},
              {"active", true},
              {"fade", 0},
              {"matrix", transform({{0, 0, 0, 1}, {0, 0, 0}})},
              {"hands", Json::array({{{"holding", false}, {"hover", nullptr}},
                                     {{"holding", false}, {"hover", nullptr}}})}};
    if (!puppet.is_null())
        c["puppet"] = puppet;
    return {{"control", c}};
}

Json rightHandPuppet() {
    return {{"v", 1},
            {"hands", Json::array({nullptr,
                                   {{"space", "head"},
                                    {"grip", {.15, -.2, -.35, 0, 0, 0, 1.2}}, // normalised on read
                                    {"aim", {.15, -.2, -.35, 0, 0, 0, 1}},
                                    {"trigger", 1.4},
                                    {"squeeze", .8},
                                    {"stick", {2, -.5}},
                                    {"a", true},
                                    {"stickClick", true}}})}};
}

PuppetState puppetFor(int hand, PuppetSpace space, XrPosef pose) {
    PuppetState p;
    auto &h = p.hands[size_t(hand)];
    h.present = true;
    h.space = space;
    h.grip = h.aim = pose;
    h.trigger = 1;
    h.squeeze = .9f;
    h.primary = true;
    return p;
}

PuppetFrame usable(XrPosef head = {{0, 0, 0, 1}, {0, 1.6f, 0}}) {
    PuppetFrame f;
    f.enabled = true;
    f.tracking = true;
    f.nowNs = 9000 * ms;
    f.receivedNs = f.nowNs - 30 * ms;
    f.head = head;
    return f;
}

InputFrame idle() {
    InputFrame frame;
    frame.head = {{0, 0, 0, 1}, {0, 1.6f, 0}};
    return frame;
}

} // namespace

// Each build runs one of these two; they stay outside the anonymous namespace so the other one is
// still compiled (and checked) without an unused-function warning.

/** Release builds (no OFFICE_CAPTURE_PUPPET): nothing reads or applies a puppet, even for a debug
 * host. */
void releaseIgnoresThePuppet() {
    assert(!capturePuppetEnabled(true) && !capturePuppetEnabled(false) &&
           "a release build cannot enable the puppet");
    BridgeState bridge;
    bridge.allowPuppet(true); // what OfficeActivity would ask for if BuildConfig.DEBUG were true
    std::string scene, error;
    assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error) && error.empty());
    assert(!bridge.read().puppet.active() && "the release bridge never parses the puppet");
    // The field is not even validated: a malformed puppet changes nothing and logs nothing.
    assert(bridge.submit(control(Json{{"v", 99}}).dump(), scene, error) && error.empty());
    assert(!bridge.read().puppet.active());
    // The display loop's gate: applyPuppet sees enabled = capturePuppetEnabled(hostDebug).
    auto frame = idle();
    const auto before = frame;
    auto at = usable();
    at.enabled = capturePuppetEnabled(true);
    assert(applyPuppet(frame, puppetFor(1, PuppetSpace::Head, {{0, 0, 0, 1}, {0, 0, -.3f}}), at) ==
           0);
    assert(same(frame.hands[0], before.hands[0]) && same(frame.hands[1], before.hands[1]));
}

/** Debug builds: both the native build and the Java host's BuildConfig.DEBUG must allow it. */
void debugGatesAndParses() {
    assert(capturePuppetEnabled(true) && !capturePuppetEnabled(false) &&
           "a debug build needs a debug Java host");
    std::string scene, error;
    {
        BridgeState bridge; // never allowed: a release Java host
        assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error) && error.empty());
        assert(!bridge.read().puppet.active());
        bridge.allowPuppet(false);
        assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error) && error.empty());
        assert(!bridge.read().puppet.active());
    }
    BridgeState bridge;
    bridge.allowPuppet(true);
    assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error) && error.empty());
    auto state = bridge.read();
    assert(state.puppet.active() && !state.puppet.hands[0].present);
    const auto &right = state.puppet.hands[1];
    assert(right.present && right.space == PuppetSpace::Head);
    assert(close(right.grip.position, {.15f, -.2f, -.35f}) && close(right.grip.orientation.w, 1));
    assert(close(right.trigger, 1) && close(right.squeeze, .8f) && "analog values are clamped");
    assert(close(right.stick.x, 1) && close(right.stick.y, -.5f));
    assert(right.primary && !right.secondary && !right.menu && right.stickClick);

    // Every space name, and the default.
    for (const auto &[name, space] :
         {std::pair<const char *, PuppetSpace>{"local", PuppetSpace::Local},
          {"heading", PuppetSpace::Heading},
          {"head", PuppetSpace::Head}}) {
        auto packet = rightHandPuppet();
        packet["hands"][1]["space"] = name;
        assert(bridge.submit(control(packet).dump(), scene, error) && error.empty());
        assert(bridge.read().puppet.hands[1].space == space);
    }
    auto packet = rightHandPuppet();
    packet["hands"][1].erase("space");
    assert(bridge.submit(control(packet).dump(), scene, error) && error.empty());
    assert(bridge.read().puppet.hands[1].space == PuppetSpace::Local);

    // A malformed puppet is dropped and reported, but the rest of the controls still apply.
    const auto revision = bridge.read().revision;
    for (const auto &mutate : std::vector<std::function<void(Json &)>>{
             [](Json &p) { p["v"] = 2; },
             [](Json &p) { p["hands"] = Json::array({nullptr}); },
             [](Json &p) { p["hands"][1]["space"] = "world"; },
             [](Json &p) {
                 p["hands"][1]["grip"] = {0, 0, 0};
             },
             [](Json &p) { p["hands"][1]["aim"] = {0, 0, 0, 0, 0, 0, 0}; },
             [](Json &p) { p["hands"][1]["grip"][0] = 5000; },
             [](Json &p) { p["hands"][1]["a"] = 1; },
             [](Json &p) { p["hands"][1]["trigger"] = "full"; },
             [](Json &p) { p["hands"][1]["stick"] = {0}; },
             [](Json &p) { p["hands"][0] = 3; },
         }) {
        auto bad = rightHandPuppet();
        mutate(bad);
        error.clear();
        assert(bridge.submit(control(bad).dump(), scene, error) && "controls survive");
        assert(error.find("Invalid capture puppet") == 0);
        assert(!bridge.read().puppet.active());
    }
    assert(bridge.read().revision > revision);

    // The page stops sending it (cleared, or a packet without one): it is gone at once.
    assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error));
    assert(bridge.read().puppet.active());
    assert(bridge.submit(control().dump(), scene, error) && error.empty());
    assert(!bridge.read().puppet.active());
    assert(bridge.submit(control(rightHandPuppet()).dump(), scene, error));
    bridge.reset(); // a page navigation
    assert(!bridge.read().puppet.active());
}

namespace {
/** The display-frame merge: a pure rule set, independent of the build gate. */
void mergeRules() {
    const XrPosef ahead{{0, 0, 0, 1}, {.15f, -.2f, -.35f}};
    // Disabled, untracked session or stale puppet: nothing changes.
    for (int c = 0; c < 5; c++) {
        auto frame = idle();
        auto at = usable();
        if (c == 0)
            at.enabled = false;
        if (c == 1)
            at.tracking = false; // focus or eye-pose loss cancels synthetic input too
        if (c == 2)
            at.receivedNs = at.nowNs - kPuppetStaleNs - ms;
        if (c == 3)
            at.receivedNs = 0;
        if (c == 4)
            at.receivedNs = at.nowNs + 5 * ms;
        assert(applyPuppet(frame, puppetFor(1, PuppetSpace::Head, ahead), at) == 0);
        assert(!frame.hands[1].active && !frame.hands[1].puppet);
    }
    {
        auto frame = idle();
        assert(applyPuppet(frame, PuppetState{}, usable()) == 0);
    }
    // On the headset the page's control packets regularly arrive 250-500 ms apart (controlAgeMs
    // 495 ms measured) while it works: the puppet stays through such a stall, up to the limit.
    for (const int64_t age : {int64_t(260) * ms, int64_t(495) * ms, kPuppetStaleNs}) {
        auto frame = idle();
        auto at = usable();
        at.receivedNs = at.nowNs - age;
        assert(applyPuppet(frame, puppetFor(1, PuppetSpace::Head, ahead), at) == 2);
        assert(frame.hands[1].puppet);
    }
    // A puppet hand never outlives the attachment it holds.
    static_assert(kPuppetStaleNs <= kAttachmentStaleNs, "the puppet must not outlive its gun");

    // An idle slot becomes a tracked controller with a tracked grip, in head space.
    auto frame = idle();
    assert(applyPuppet(frame, puppetFor(1, PuppetSpace::Head, ahead), usable()) == 2);
    const auto &right = frame.hands[1];
    assert(right.active && right.gripTracked && right.puppet && !frame.hands[0].active);
    assert(close(right.grip.position, {.15f, 1.4f, -.35f}) &&
           close(right.aim.position, {.15f, 1.4f, -.35f}));
    assert(close(right.trigger, 1) && close(right.squeeze, .9f) && right.primary && !right.ui);

    // A real tracked controller always wins; an untracked one is replaced.
    frame = idle();
    frame.hands[0].active = frame.hands[1].active = true;
    frame.hands[0].gripTracked = true;
    frame.hands[0].grip = {{0, 0, 0, 1}, {-.3f, 1.1f, -.2f}};
    frame.hands[1].gripTracked = false; // aim only: not a tracked controller
    auto both = puppetFor(1, PuppetSpace::Head, ahead);
    both.hands[0] = both.hands[1];
    assert(applyPuppet(frame, both, usable()) == 2);
    assert(!frame.hands[0].puppet && close(frame.hands[0].grip.position, {-.3f, 1.1f, -.2f}));
    assert(frame.hands[1].puppet && frame.hands[1].gripTracked);

    // Head space follows the full head pose of this display frame.
    const auto turned = XrPosef{axisAngle({0, 1, 0}, 1.5707963f), {1, 1.5f, 2}};
    frame = idle();
    applyPuppet(frame, puppetFor(1, PuppetSpace::Head, ahead), usable(turned));
    assert(close(frame.hands[1].grip.position, {1 - .35f, 1.3f, 2 - .15f}));
    // Heading space keeps only the heading: a pitched head does not move a holstered gun.
    const XrPosef holster{{0, 0, 0, 1}, {.15f, -.55f, .3f}};
    frame = idle();
    applyPuppet(frame, puppetFor(1, PuppetSpace::Heading, holster), usable(turned));
    const auto level = frame.hands[1].grip;
    const auto pitched =
        XrPosef{multiply(turned.orientation, axisAngle({1, 0, 0}, -.6f)), turned.position};
    frame = idle();
    applyPuppet(frame, puppetFor(1, PuppetSpace::Heading, holster), usable(pitched));
    assert(close(frame.hands[1].grip.position, level.position));
    assert(close(level.position, {1 + .3f, 1.5f - .55f, 2 - .15f}));
    // Looking straight down still has a heading (the head's up vector).
    const auto down =
        XrPosef{multiply(turned.orientation, axisAngle({1, 0, 0}, -1.5707963f)), turned.position};
    frame = idle();
    applyPuppet(frame, puppetFor(1, PuppetSpace::Heading, holster), usable(down));
    assert(close(frame.hands[1].grip.position, level.position, 1e-3f));
    // Local space is used as given.
    frame = idle();
    applyPuppet(frame, puppetFor(0, PuppetSpace::Local, {{0, 0, 0, 1}, {-.2f, 1, -.4f}}),
                usable(turned));
    assert(close(frame.hands[0].grip.position, {-.2f, 1, -.4f}) && frame.hands[0].puppet);
}

/** Held objects render at a puppet grip exactly as at a tracked one. */
void attachmentsFollowThePuppet() {
    auto frame = idle();
    applyPuppet(frame, puppetFor(1, PuppetSpace::Head, {{0, 0, 0, 1}, {.15f, -.2f, -.35f}}),
                usable());
    AttachmentFrame at;
    at.focused = at.poseValid = at.shouldRender = at.controlsActive = true;
    at.nowNs = 5000 * ms;
    at.receivedNs = at.nowNs - 20 * ms;
    const auto rig = transform({{0, 0, 0, 1}, {4, 0, -2}});
    const auto poses = attachmentPoses(frame, rig, at);
    assert(!poses.valid[0] && poses.valid[1] && poses.held[1]);
    assert(close(poses.grip[1][12], 4.15f) && close(poses.grip[1][13], 1.4f) &&
           close(poses.grip[1][14], -2.35f));
    // Through a 495 ms page stall both the puppet hand and the gun it holds stay: a capture never
    // shows the controller without its gun.
    auto stalled = usable();
    stalled.receivedNs = stalled.nowNs - 495 * ms;
    frame = idle();
    assert(applyPuppet(frame, puppetFor(1, PuppetSpace::Head, {{0, 0, 0, 1}, {.15f, -.2f, -.35f}}),
                       stalled) == 2);
    at.nowNs = stalled.nowNs;
    at.receivedNs = stalled.receivedNs;
    assert(attachmentPoses(frame, rig, at).valid[1]);
}
} // namespace

int main() {
    if constexpr (kCapturePuppetBuild)
        debugGatesAndParses();
    else
        releaseIgnoresThePuppet();
    mergeRules();
    attachmentsFollowThePuppet();
    std::printf("capture puppet tests passed (%s build)\n",
                kCapturePuppetBuild ? "debug: OFFICE_CAPTURE_PUPPET" : "release: no puppet");
}
