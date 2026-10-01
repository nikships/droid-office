// Grip-attached scene objects: the display-frame grip composition, its validity rules, and the
// renderer's per-item placement, all GL-free.
#include "controller_attachment.h"
#include "scene_model.h"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>

using namespace office;
namespace {
constexpr float pi = 3.14159265358979323846f;
constexpr int64_t ms = 1'000'000;

bool close(float a, float b, float tolerance = 1e-4f) { return std::abs(a - b) < tolerance; }
bool close(XrVector3f a, XrVector3f b, float tolerance = 1e-4f) {
    return close(a.x, b.x, tolerance) && close(a.y, b.y, tolerance) && close(a.z, b.z, tolerance);
}

XrQuaternionf axisAngle(XrVector3f axis, float angle) {
    const float s = std::sin(angle / 2);
    return {axis.x * s, axis.y * s, axis.z * s, std::cos(angle / 2)};
}

AttachmentFrame usable(int64_t now = 5000 * ms) {
    AttachmentFrame f;
    f.focused = f.poseValid = f.shouldRender = f.controlsActive = true;
    f.nowNs = now;
    f.receivedNs = now - 20 * ms;
    return f;
}

InputFrame hands() {
    InputFrame frame;
    frame.hands[0].active = frame.hands[1].active = true;
    frame.hands[0].gripTracked = frame.hands[1].gripTracked = true;
    frame.hands[0].grip = {axisAngle({1, 0, 0}, -.5f), {-.2f, 1.1f, -.3f}};
    frame.hands[1].grip = {axisAngle({0, 0, 1}, .8f), {.25f, 1.05f, -.35f}};
    return frame;
}

/** A gun modeled facing +Z, turned by PI around Y on its grip: muzzle 18 cm ahead of the grip. */
scene::DrawItem gunItem(int8_t hand) {
    scene::DrawItem it;
    it.attachment = hand;
    const Matrix relative = transform({axisAngle({0, 1, 0}, pi), {0, -.02f, .03f}});
    std::copy(relative.begin(), relative.end(), it.model);
    it.sphere = {{0, 0, .1f}, .12f};
    return it;
}

XrVector3f muzzle(const float model[16]) {
    Matrix m;
    std::copy(model, model + 16, m.begin());
    return transformPoint(m, {0, 0, .18f}); // model space: +Z forward
}

void muzzleFollowsBothGripsUnderRigMotion() {
    const auto input = hands();
    for (const float rigYaw : {0.f, .7f, -2.4f, pi}) {
        const Matrix rig = transform({yaw(rigYaw), {3.5f, .4f, -7.25f}});
        const auto poses = attachmentPoses(input, rig, usable());
        for (int h = 0; h < 2; h++) {
            assert(poses.valid[h]);
            assert(scene::rigidPose(poses.grip[h]));
            const XrPosef grip = input.hands[size_t(h)].grip;
            // The native controller model is drawn at rig * grip; the gun must share it exactly.
            const XrPosef world = compose({yaw(rigYaw), {rig[12], rig[13], rig[14]}}, grip);
            for (int i = 0; i < 16; i++)
                assert(close(poses.grip[h][i], transform(world)[i]));
            auto gun = gunItem(int8_t(h));
            auto placed = gun;
            scene::placeAttachment(gun, poses.grip[h], placed);
            // The +Z model turned by PI points along grip -Z: the muzzle is ahead of the grip.
            const XrVector3f expected =
                compose(world, {{0, 0, 0, 1}, {0, -.02f, .03f - .18f}}).position;
            assert(close(muzzle(placed.model), expected));
            assert(
                close(placed.sphere.c.x, compose(world, {{0, 0, 0, 1}, {0, 0, .1f}}).position.x));
            assert(close(placed.sphere.r, .12f));
            // Normals: grip * PI yaw rotates the model's +X normal to world -(grip X).
            const float *n = placed.normal;
            const XrVector3f normal{n[0], n[1], n[2]};
            assert(close(normal, scale(rotate(world.orientation, {1, 0, 0}), -1)));
            assert(!placed.mirrored);
        }
    }
    // Rig translation alone moves the muzzle by exactly that translation.
    const auto a = attachmentPoses(input, transform({yaw(.3f), {0, 0, 0}}), usable());
    const auto b = attachmentPoses(input, transform({yaw(.3f), {1, 2, 3}}), usable());
    auto gun = gunItem(1), pa = gun, pb = gun;
    scene::placeAttachment(gun, a.grip[1], pa);
    scene::placeAttachment(gun, b.grip[1], pb);
    assert(close(subtract(muzzle(pb.model), muzzle(pa.model)), {1, 2, 3}));
}

void invalidFramesHide() {
    const auto input = hands();
    const Matrix rig = transform({yaw(.2f), {1, 0, 1}});
    auto invalid = [&](AttachmentFrame f, const InputFrame &in) {
        auto poses = attachmentPoses(in, rig, f);
        return !poses.valid[0] && !poses.valid[1];
    };
    auto f = usable();
    f.focused = false;
    assert(invalid(f, input));
    f = usable();
    f.poseValid = false;
    assert(invalid(f, input));
    f = usable();
    f.shouldRender = false;
    assert(invalid(f, input));
    f = usable();
    f.controlsActive = false;
    assert(invalid(f, input));
    // A page stall of the length measured on the headset (controlAgeMs 495 ms) keeps the gun in
    // the hand; a page that stopped answering loses it.
    f = usable();
    f.receivedNs = f.nowNs - 495 * ms;
    assert(!invalid(f, input));
    f.receivedNs = f.nowNs - kAttachmentStaleNs - 1;
    assert(invalid(f, input));
    f.receivedNs = f.nowNs - kAttachmentStaleNs;
    assert(!invalid(f, input));
    f.receivedNs = 0;
    assert(invalid(f, input));
    f.receivedNs = f.nowNs + 50 * ms; // a clock from the future is not fresh
    assert(invalid(f, input));
    // Per hand: inactive, or located but not tracked.
    auto lost = input;
    lost.hands[0].active = false;
    lost.hands[1].gripTracked = false;
    assert(invalid(usable(), lost));
    auto one = input;
    one.hands[0].gripTracked = false;
    auto poses = attachmentPoses(one, rig, usable());
    assert(!poses.valid[0] && poses.valid[1]);
    // Active aim fallback is insufficient; only the input layer's tracked grip may attach.
    InputFrame plain;
    plain.hands[1].active = true;
    poses = attachmentPoses(plain, rig, usable());
    assert(!poses.valid[0] && !poses.valid[1]);
    plain.hands[1].gripTracked = true;
    poses = attachmentPoses(plain, rig, usable());
    assert(!poses.valid[0] && poses.valid[1]);
}

void squeezeHolds() {
    const Matrix rig = transform({yaw(.2f), {1, 0, 1}});
    auto input = hands();
    input.hands[0].squeeze = kGripHeldSqueeze;
    input.hands[1].squeeze = .59f;
    auto poses = attachmentPoses(input, rig, usable());
    // The page's grab latch keeps holding at 0.6 and releases below it.
    assert(poses.valid[0] && poses.held[0]);
    assert(poses.valid[1] && !poses.held[1]);
    input.hands[1].squeeze = 1;
    poses = attachmentPoses(input, rig, usable());
    assert(poses.held[1]);
    // A squeeze never holds without a valid grip.
    auto f = usable();
    f.focused = false;
    poses = attachmentPoses(input, rig, f);
    assert(!poses.held[0] && !poses.held[1]);
    input.hands[1].gripTracked = false;
    poses = attachmentPoses(input, rig, usable());
    assert(poses.held[0] && !poses.valid[1] && !poses.held[1]);
}

void rigidGripsOnly() {
    float m[16];
    const Matrix good = transform({axisAngle({.6f, .8f, 0}, 1.1f), {1, 2, 3}});
    std::copy(good.begin(), good.end(), m);
    assert(scene::rigidPose(m));
    float scaled[16];
    std::copy(m, m + 16, scaled);
    for (int i = 0; i < 3; i++)
        scaled[i] *= 1.5f;
    assert(!scene::rigidPose(scaled));
    float mirrored[16];
    std::copy(m, m + 16, mirrored);
    for (int i = 8; i < 11; i++)
        mirrored[i] = -mirrored[i];
    assert(!scene::rigidPose(mirrored));
    float projective[16];
    std::copy(m, m + 16, projective);
    projective[3] = .1f;
    assert(!scene::rigidPose(projective));
    float broken[16];
    std::copy(m, m + 16, broken);
    broken[13] = std::numeric_limits<float>::quiet_NaN();
    assert(!scene::rigidPose(broken));
    broken[13] = std::numeric_limits<float>::infinity();
    assert(!scene::rigidPose(broken));
}

void mirroredChildKeepsWinding() {
    auto gun = gunItem(0);
    gun.mirrored = true;
    gun.model[0] = -gun.model[0];
    gun.model[1] = -gun.model[1];
    gun.model[2] = -gun.model[2];
    auto placed = gun;
    const Matrix grip = transform({axisAngle({0, 1, 0}, .4f), {0, 1, 0}});
    scene::placeAttachment(gun, grip.data(), placed);
    assert(placed.mirrored);
    // The normal matrix is the inverse transpose of the composed matrix: n . (M t) == 0 when
    // n . t == 0 in model space, for a tangent t and normal n.
    Matrix world;
    std::copy(placed.model, placed.model + 16, world.begin());
    const XrVector3f t =
        subtract(transformPoint(world, {0, 1, 0}), transformPoint(world, {0, 0, 0}));
    const float *n = placed.normal;
    const XrVector3f nx{n[0], n[1], n[2]}; // model +X normal
    assert(close(nx.x * t.x + nx.y * t.y + nx.z * t.z, 0));
}
} // namespace

int main() {
    muzzleFollowsBothGripsUnderRigMotion();
    invalidFramesHide();
    squeezeHolds();
    rigidGripsOnly();
    mirroredChildKeepsWinding();
    std::puts("controller attachment tests passed");
}
