#include "vk_spike_logic.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
#include <string>
using namespace office::spike;

namespace {
void options() {
    const auto defaults = parseOptions("renderer=vulkan-spike");
    assert(defaults.msaa == Msaa::Resolve4 && defaults.offsets == Offsets::Eye);
    assert(defaults.level == 3 && defaults.overlay && !defaults.fixed && defaults.foveation);
    assert(!defaults.subsampledProbe && defaults.flip == Flip::None);
    assert(defaults.profile == ProfileMode::Live && !defaults.eyePermission);
    assert(defaults.warnings.empty());

    const auto all = parseOptions("renderer=vulkan-spike;msaa=4ms;offsets=sweep;level=low;"
                                  "overlay=0;fixed=1;foveation=off;subsampled_probe=true;flip=xy;"
                                  "profile=godot;eye_permission=1");
    assert(all.msaa == Msaa::RenderToSingle4 && all.offsets == Offsets::Sweep && all.level == 1);
    assert(!all.overlay && all.fixed && !all.foveation && all.subsampledProbe);
    assert(all.flip == Flip::XY && all.profile == ProfileMode::PerFrame && all.eyePermission);
    assert(all.warnings.empty());
    assert(parseOptions("msaa=1;offsets=none;level=none;flip=y;profile=per-frame").msaa ==
           Msaa::Single);
    assert(parseOptions("level=medium").level == 2);
    assert(parseOptions("offsets=none").offsets == Offsets::None);

    // Unknown keys and values are reported and leave the defaults.
    const auto bad = parseOptions("renderer=gles;msaa=8;level=ultra;overlay=maybe;color=red;;");
    assert(bad.msaa == Msaa::Resolve4 && bad.level == 3 && bad.overlay);
    assert(bad.warnings.size() == 5);
    assert(bad.warnings[0] == "renderer=gles" && bad.warnings[4] == "color=red");
    const auto text = describe(all).dump();
    assert(text.find("\"msaa\":\"4ms\"") != std::string::npos);
    assert(text.find("\"profile\":\"per-frame\"") != std::string::npos);
    assert(std::string(levelName(0)) == "none" && std::string(levelName(4)) == "?");
}

void rounding() {
    assert(roundToGranularity(0, 32) == 0);
    assert(roundToGranularity(15.9f, 32) == 0);
    assert(roundToGranularity(16, 32) == 32);
    assert(roundToGranularity(47, 32) == 32);
    assert(roundToGranularity(49, 32) == 64);
    // Symmetric for negative offsets.
    assert(roundToGranularity(-47, 32) == -32);
    assert(roundToGranularity(-49, 32) == -64);
    assert(roundToGranularity(-16, 32) == -32);
    assert(roundToGranularity(7.4f, 1) == 7 && roundToGranularity(7.6f, 0) == 8);
    assert(roundToGranularity(-7.6f, -4) == -8);
    assert(roundToGranularity(std::numeric_limits<float>::quiet_NaN(), 8) == 0);
    assert(roundToGranularity(std::numeric_limits<float>::infinity(), 8) == 0);
}

void offsets() {
    // centre * (size / 2), rounded to the granularity (Godot's mapping).
    assert((centreOffset(0, 0, Flip::None, 2000, 2400, 32, 32) == Offset{0, 0}));
    assert((centreOffset(1, 1, Flip::None, 2000, 2400, 32, 32) == Offset{992, 1216}));
    assert((centreOffset(-1, -1, Flip::None, 2000, 2400, 32, 32) == Offset{-992, -1216}));
    assert((centreOffset(.25f, -.5f, Flip::None, 2048, 2048, 1, 1) == Offset{256, -512}));
    // Out-of-range and non-finite centres clamp to the documented -1..1.
    assert((centreOffset(3, -7, Flip::None, 100, 100, 1, 1) == Offset{50, -50}));
    assert((centreOffset(std::numeric_limits<float>::quiet_NaN(), .5f, Flip::None, 100, 100, 1,
                         1) == Offset{0, 25}));
    assert((centreOffset(.25f, .5f, Flip::X, 100, 100, 1, 1) == Offset{-13, 25}));
    assert((centreOffset(.25f, .5f, Flip::Y, 100, 100, 1, 1) == Offset{13, -25}));
    assert((centreOffset(.25f, .5f, Flip::XY, 100, 100, 1, 1) == Offset{-13, -25}));
    // Every result is a multiple of the granularity.
    for (int i = -20; i <= 20; ++i) {
        const auto o = centreOffset(i / 20.f, -i / 31.f, Flip::None, 2152, 2504, 16, 24);
        assert(o.x % 16 == 0 && o.y % 24 == 0);
        assert(std::abs(o.x) <= 1076 + 8 && std::abs(o.y) <= 1252 + 12);
    }
    // A positive offset moves the map right and down in framebuffer pixels.
    const auto marker = markerPixel({64, -32}, 2000, 1000);
    assert(marker[0] == 1064 && marker[1] == 468);
}

void gaze() {
    // Straight ahead in a symmetric view is the centre; a symmetric FOV of tan 1 maps tan 0.5
    // right and up to (0.5, 0.5) with +y up.
    auto c = gazeNdc(0, 0, -1, -1, 1, -1, 1);
    assert(c[0] == 0 && c[1] == 0);
    c = gazeNdc(.5f, .5f, -1, -1, 1, -1, 1);
    assert(std::abs(c[0] - .5f) < 1e-6f && std::abs(c[1] - .5f) < 1e-6f);
    // An asymmetric FOV moves the centre: tan(-1.2)..tan(0.8) horizontally.
    c = gazeNdc(0, 0, -2, -1.2f, .8f, -1, 1);
    assert(std::abs(c[0] - .2f) < 1e-6f && c[1] == 0);
    // Behind the eye or a degenerate FOV gives the centre.
    c = gazeNdc(.3f, .2f, 1, -1, 1, -1, 1);
    assert(c[0] == 0 && c[1] == 0);
    c = gazeNdc(.3f, .2f, -1, 1, 1, -1, 1);
    assert(c[0] == 0 && c[1] == 0);
}

void sweep() {
    const auto start = sweepPoint(0);
    assert(start.index == 0 && start.x == 0 && start.y == 0);
    assert(sweepPoint(2.9).index == 0);
    const auto right = sweepPoint(3.0);
    assert(right.index == 1 && right.x == .5f && right.y == 0);
    const auto down = sweepPoint(6.5);
    assert(down.index == 2 && down.x == 0 && down.y == .5f);
    assert(sweepPoint(9).index == 3 && sweepPoint(9).x == -.5f);
    assert(sweepPoint(12).index == 4 && sweepPoint(12).y == -.5f);
    assert(sweepPoint(15).index == 0);
    assert(sweepPoint(31, 2).index == 0 && sweepPoint(33, 2).index == 1);
    assert(sweepPoint(-1).index == 0 && sweepPoint(5, 0).index == 0);
    assert(sweepPoint(std::numeric_limits<double>::quiet_NaN()).index == 0);
}

void logGate() {
    LogGate gate(3, 1);
    // A burst after (re)start, then only changes or once per period.
    assert(gate.shouldLog(0, 7));
    assert(gate.shouldLog(.01, 7));
    assert(gate.shouldLog(.02, 7));
    assert(!gate.shouldLog(.03, 7));
    assert(!gate.shouldLog(.5, 7));
    assert(gate.shouldLog(.51, 8));
    assert(!gate.shouldLog(.52, 8));
    assert(gate.shouldLog(1.6, 8));
    assert(!gate.shouldLog(2.0, 8));
    gate.restart();
    assert(gate.shouldLog(2.01, 8));
    assert(gate.shouldLog(2.02, 8));
    assert(gate.shouldLog(2.03, 8));
    assert(!gate.shouldLog(2.04, 8));
}

void window() {
    FoveationWindow empty;
    auto json = empty.json();
    assert(json["frames"] == 0 && json["centres"].is_null() && json["offsets"].is_null());
    assert(json["centreSpread"].is_null());

    FoveationWindow window;
    FoveationFrame failed;
    failed.updated = failed.queried = true;
    failed.updateResult = 0;
    failed.stateResult = -2;
    window.add(failed);
    FoveationFrame a;
    a.updated = a.queried = a.valid = a.applied = true;
    a.flags = 1;
    a.centres = {{{.1f, -.2f}, {.15f, -.2f}}};
    a.offsets = {{{96, -224}, {160, -224}}};
    window.add(a);
    FoveationFrame b = a;
    b.centres = {{{.3f, -.1f}, {.35f, -.1f}}};
    window.add(b);
    FoveationFrame fixed;
    window.add(fixed);
    json = window.json();
    assert(json["frames"] == 4 && json["updates"] == 3 && json["updateFailures"] == 0);
    assert(json["queries"] == 3 && json["querySuccess"] == 2 && json["valid"] == 2);
    assert(json["applied"] == 2 && json["lastState"] == 0 && json["lastFlags"] == 1);
    assert(std::abs(json["centres"][0][0].get<float>() - .3f) < 1e-6f);
    assert(std::abs(json["centreSpread"][0][0].get<float>() - .2f) < 1e-6f);
    assert(std::abs(json["centreSpread"][1][1].get<float>() - .1f) < 1e-6f);
    assert(json["offsets"][1][0] == 160 && json["offsets"][1][1] == -224);

    FoveationFrame updateFailed;
    updateFailed.updated = true;
    updateFailed.updateResult = -1;
    FoveationWindow failures;
    failures.add(updateFailed);
    assert(failures.json()["updateFailures"] == 1 && failures.json()["lastUpdate"] == -1);
}

void gates() {
    EyeGates g;
    assert(!g.eyeProfile() && !g.query() && !g.offsets());
    assert(g.blockers() ==
           "densityMap,metaExtension,systemSupports,permission,gazeInteraction,offsetFeature,"
           "swapchainOffset");
    g.densityMap = g.metaExtension = g.systemSupports = g.permission = true;
    assert(g.eyeProfile() && !g.query());
    g.gazeInteraction = true;
    assert(g.query() && !g.offsets());
    g.offsetFeature = g.swapchainOffset = true;
    assert(g.offsets() && g.blockers().empty());
    g.fixedRequested = true;
    assert(!g.eyeProfile() && !g.query() && g.offsets());
    assert(g.blockers() == "fixedRequested");
    g.fixedRequested = false;
    g.permission = false;
    assert(!g.eyeProfile() && g.blockers() == "permission");

    Options o;
    FoveationFrame last;
    last.queried = last.valid = true;
    last.centres = {{{.12f, -.05f}, {.1f, -.05f}}};
    last.offsets = {{{128, -64}, {96, -64}}};
    g.permission = true;
    const auto packet = statusPacket(o, g, last, 90);
    const std::string aim = packet["aim"], message = packet["message"];
    assert(aim.find("level high") != std::string::npos);
    assert(aim.find("eye-tracked") != std::string::npos);
    assert(message.find("VALID") != std::string::npos);
    assert(message.find("128 -64") != std::string::npos);
    o.offsets = Offsets::Sweep;
    assert(std::string(statusPacket(o, g, last, 90)["aim"]).find("(synthetic)") !=
           std::string::npos);
    g.fixedRequested = true;
    const std::string fixedMessage = statusPacket(o, g, FoveationFrame{}, 72)["message"];
    assert(fixedMessage.find("no eye-tracked query (fixedRequested)") != std::string::npos);
}

void room() {
    const float floorY = 0;
    const auto mesh = buildRoom(floorY);
    // 6 room faces and 3 cubes of 6 faces, 4 vertices and 2 triangles each.
    assert(mesh.vertices.size() == 24 * 4 && mesh.indices.size() == 24 * 6);
    for (auto index : mesh.indices)
        assert(index < mesh.vertices.size());
    int materials[6]{};
    for (const auto &v : mesh.vertices) {
        const float length = std::sqrt(v.normal[0] * v.normal[0] + v.normal[1] * v.normal[1] +
                                       v.normal[2] * v.normal[2]);
        assert(std::abs(length - 1) < 1e-6f);
        assert(v.position[0] >= -RoomLayout::halfWidth && v.position[0] <= RoomLayout::halfWidth);
        assert(v.position[1] >= floorY && v.position[1] <= floorY + RoomLayout::height);
        assert(v.position[2] >= RoomLayout::front && v.position[2] <= RoomLayout::back);
        const int m = static_cast<int>(v.material);
        assert(m >= 0 && m <= 5 && v.material == m);
        ++materials[m];
    }
    assert(materials[0] == 4 && materials[1] == 16 && materials[2] == 4);
    assert(materials[3] == 24 && materials[4] == 24 && materials[5] == 24);
    for (size_t t = 0; t < mesh.indices.size(); t += 3) {
        const auto &a = mesh.vertices[mesh.indices[t]], &b = mesh.vertices[mesh.indices[t + 1]],
                   &c = mesh.vertices[mesh.indices[t + 2]];
        float u[3], w[3];
        for (int i = 0; i < 3; ++i) {
            u[i] = b.position[i] - a.position[i];
            w[i] = c.position[i] - a.position[i];
        }
        const float cross[3]{u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2],
                             u[0] * w[1] - u[1] * w[0]};
        // Counter-clockwise seen from the side the normal points to.
        assert(cross[0] * a.normal[0] + cross[1] * a.normal[1] + cross[2] * a.normal[2] > 0);
        if (a.material <= 2) {
            // Room faces point into the room.
            const float toCentre[3]{-a.position[0], floorY + RoomLayout::height / 2 - a.position[1],
                                    (RoomLayout::front + RoomLayout::back) / 2 - a.position[2]};
            assert(toCentre[0] * a.normal[0] + toCentre[1] * a.normal[1] +
                       toCentre[2] * a.normal[2] >
                   0);
        }
    }
    // Cube centres sit at the documented depths.
    for (int cube = 0; cube < 3; ++cube) {
        float z = 0;
        int n = 0;
        for (const auto &v : mesh.vertices)
            if (static_cast<int>(v.material) == 3 + cube) {
                z += v.position[2];
                ++n;
            }
        assert(std::abs(z / n + RoomLayout::cubeDepths[cube]) < 1e-5f);
    }
    // LOCAL space (no floor extension) lowers everything by the same height.
    const auto low = buildRoom(-1.6f);
    assert(std::abs(low.vertices[0].position[1] - (mesh.vertices[0].position[1] - 1.6f)) < 1e-6f);
}
} // namespace

int main() {
    options();
    rounding();
    offsets();
    gaze();
    sweep();
    logGate();
    window();
    gates();
    room();
    std::cout << "vk_spike_logic tests passed\n";
}
