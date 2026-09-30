#pragma once
#include "xr_math.h"
#include <algorithm>
#include <cstdint>
#include <vector>

namespace office {
/** Immutable runtime mesh; retrieved once, never copied through the JavaScript bridge. */
struct HandMesh {
    std::array<XrPosef, XR_HAND_JOINT_COUNT_EXT> bind{};
    std::array<float, XR_HAND_JOINT_COUNT_EXT> radii{};
    std::array<XrHandJointEXT, XR_HAND_JOINT_COUNT_EXT> parents{};
    std::vector<XrVector3f> positions, normals;
    std::vector<XrVector2f> uv;
    std::vector<XrVector4sFB> joints;
    std::vector<XrVector4f> weights;
    std::vector<int16_t> indices;
    std::array<Matrix, XR_HAND_JOINT_COUNT_EXT> inverseBind{};
    std::array<bool, XR_HAND_JOINT_COUNT_EXT> used{};
};
inline bool finiteHandPose(XrPosef p) {
    auto q = p.orientation;
    float n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    return std::isfinite(p.position.x) && std::isfinite(p.position.y) &&
           std::isfinite(p.position.z) && std::isfinite(n) && n > .99f && n < 1.01f;
}
/** Treat extension output as bounded input. Reject corrupt geometry before uploading it. */
inline bool validateHandMesh(HandMesh &mesh) {
    size_t n = mesh.positions.size();
    if (!n || n > 16384 || mesh.normals.size() != n || mesh.uv.size() != n ||
        mesh.joints.size() != n || mesh.weights.size() != n || mesh.indices.empty() ||
        mesh.indices.size() > 96000 || mesh.indices.size() % 3)
        return false;
    mesh.used.fill(false);
    for (size_t j = 0; j < mesh.bind.size(); j++) {
        if (!finiteHandPose(mesh.bind[j]) || !std::isfinite(mesh.radii[j]) || mesh.radii[j] < 0 ||
            mesh.radii[j] > .1f)
            return false;
        mesh.inverseBind[j] = inverse(mesh.bind[j]);
    }
    for (size_t v = 0; v < n; v++) {
        auto p = mesh.positions[v], normal = mesh.normals[v];
        auto uv = mesh.uv[v];
        if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z) ||
            std::abs(p.x) > 1 || std::abs(p.y) > 1 || std::abs(p.z) > 1 ||
            !std::isfinite(normal.x) || !std::isfinite(normal.y) || !std::isfinite(normal.z) ||
            !std::isfinite(uv.x) || !std::isfinite(uv.y))
            return false;
        const auto indices = mesh.joints[v];
        auto &w = mesh.weights[v];
        const int bones[]{indices.x, indices.y, indices.z, indices.w};
        float *values[]{&w.x, &w.y, &w.z, &w.w};
        float sum = 0;
        for (int k = 0; k < 4; k++) {
            if (bones[k] < 0 || bones[k] >= XR_HAND_JOINT_COUNT_EXT || !std::isfinite(*values[k]) ||
                *values[k] < 0 || *values[k] > 1.001f)
                return false;
            sum += *values[k];
            if (*values[k] > 0)
                mesh.used[bones[k]] = true;
        }
        if (sum < .99f || sum > 1.01f)
            return false;
        for (auto value : values)
            *value /= sum;
    }
    for (auto i : mesh.indices)
        if (i < 0 || size_t(i) >= n)
            return false;
    return true;
}
/** Current joint poses are already in base space, so parent transforms are not multiplied again. */
inline bool
handSkinMatrices(const HandMesh &mesh,
                 const std::array<XrHandJointLocationEXT, XR_HAND_JOINT_COUNT_EXT> &joints,
                 std::array<Matrix, XR_HAND_JOINT_COUNT_EXT> &out) {
    constexpr auto valid =
        XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
    for (size_t j = 0; j < joints.size(); j++) {
        if (!mesh.used[j]) {
            out[j] = transform({{0, 0, 0, 1}, {0, 0, 0}});
            continue;
        }
        if ((joints[j].locationFlags & valid) != valid || !finiteHandPose(joints[j].pose))
            return false;
        out[j] = multiply(transform(joints[j].pose), mesh.inverseBind[j]);
    }
    return true;
}
} // namespace office
