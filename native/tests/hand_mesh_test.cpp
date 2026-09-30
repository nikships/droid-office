#include "hand_mesh.h"
#include <cassert>
#include <cstdio>
#include <limits>
using namespace office;
HandMesh mesh() {
    HandMesh m;
    for (auto &p : m.bind)
        p = {{0, 0, 0, 1}, {0, 0, 0}};
    m.positions = {{0, 0, 0}, {.02f, 0, 0}, {0, .02f, 0}};
    m.normals.assign(3, {0, 0, 1});
    m.uv.resize(3);
    m.joints.assign(3, {1, 2, 0, 0});
    m.weights.assign(3, {.5f, .5f, 0, 0});
    m.indices = {0, 1, 2};
    return m;
}
int main() {
    auto m = mesh();
    m.bind[1].position = {.1f, 0, 0};
    m.bind[2].position = {0, .2f, 0};
    assert(validateHandMesh(m));
    std::array<XrHandJointLocationEXT, XR_HAND_JOINT_COUNT_EXT> joints{};
    for (int j : {1, 2}) {
        joints[j].locationFlags =
            XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
        joints[j].pose = m.bind[j];
        joints[j].pose.position.x += .3f;
    }
    std::array<Matrix, XR_HAND_JOINT_COUNT_EXT> bones{};
    assert(handSkinMatrices(m, joints, bones));
    for (int j : {1, 2}) {
        auto p = transformPoint(bones[j], {.02f, 0, 0});
        assert(std::abs(p.x - .32f) < 1e-5f && std::abs(p.y) < 1e-5f);
    }
    joints[2].locationFlags = 0;
    assert(!handSkinMatrices(m, joints, bones));
    auto bad = mesh();
    bad.joints[0].x = 26;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.weights[0].y = -.1f;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.weights[0].x = std::numeric_limits<float>::quiet_NaN();
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.indices[1] = -1;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.indices[2] = 3;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.positions[0].x = 10;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.bind[0].orientation.w = 0;
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.normals.pop_back();
    assert(!validateHandMesh(bad));
    bad = mesh();
    bad.positions.resize(16385);
    assert(!validateHandMesh(bad));
    std::puts("Hand mesh bounds, weighted bind poses and tracking-loss tests passed");
}
