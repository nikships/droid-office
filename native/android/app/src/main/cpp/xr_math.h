#pragma once
#include <array>
#include <cmath>
#include <openxr/openxr.h>

namespace office {
using Matrix = std::array<float, 16>;
inline XrQuaternionf conjugate(XrQuaternionf q) { return {-q.x, -q.y, -q.z, q.w}; }
inline XrQuaternionf multiply(XrQuaternionf a, XrQuaternionf b) {
    return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}
inline XrVector3f rotate(XrQuaternionf q, XrVector3f v) {
    XrQuaternionf r = multiply(multiply(q, {v.x, v.y, v.z, 0}), conjugate(q));
    return {r.x, r.y, r.z};
}
inline XrVector3f add(XrVector3f a, XrVector3f b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline XrVector3f subtract(XrVector3f a, XrVector3f b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline XrVector3f scale(XrVector3f a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline XrQuaternionf yaw(float angle) { return {0, std::sin(angle / 2), 0, std::cos(angle / 2)}; }
inline XrPosef compose(XrPosef parent, XrPosef child) {
    return {multiply(parent.orientation, child.orientation),
            add(parent.position, rotate(parent.orientation, child.position))};
}
inline Matrix transform(XrPosef pose) {
    const auto q = pose.orientation;
    return {1 - 2 * q.y * q.y - 2 * q.z * q.z,
            2 * q.x * q.y + 2 * q.z * q.w,
            2 * q.x * q.z - 2 * q.y * q.w,
            0,
            2 * q.x * q.y - 2 * q.z * q.w,
            1 - 2 * q.x * q.x - 2 * q.z * q.z,
            2 * q.y * q.z + 2 * q.x * q.w,
            0,
            2 * q.x * q.z + 2 * q.y * q.w,
            2 * q.y * q.z - 2 * q.x * q.w,
            1 - 2 * q.x * q.x - 2 * q.y * q.y,
            0,
            pose.position.x,
            pose.position.y,
            pose.position.z,
            1};
}
inline Matrix inverse(XrPosef pose) {
    auto q = conjugate(pose.orientation);
    return transform({q, rotate(q, scale(pose.position, -1))});
}
inline XrVector3f transformPoint(const Matrix &m, XrVector3f p) {
    return {m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
            m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]};
}
inline Matrix inverseRigid(const Matrix &m) {
    Matrix out{m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1};
    auto p = transformPoint(out, {-m[12], -m[13], -m[14]});
    out[12] = p.x;
    out[13] = p.y;
    out[14] = p.z;
    return out;
}
inline Matrix multiply(const Matrix &a, const Matrix &b) {
    Matrix c{};
    for (int col = 0; col < 4; col++)
        for (int row = 0; row < 4; row++)
            for (int k = 0; k < 4; k++)
                c[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    return c;
}
inline Matrix projection(XrFovf fov, float nearZ = 0.05f, float farZ = 160.f) {
    float l = std::tan(fov.angleLeft), r = std::tan(fov.angleRight), b = std::tan(fov.angleDown),
          t = std::tan(fov.angleUp);
    return {2 / (r - l),
            0,
            0,
            0,
            0,
            2 / (t - b),
            0,
            0,
            (r + l) / (r - l),
            (t + b) / (t - b),
            -(farZ + nearZ) / (farZ - nearZ),
            -1,
            0,
            0,
            -2 * farZ * nearZ / (farZ - nearZ),
            0};
}
inline bool panelHit(XrPosef ray, XrPosef panel, float width, float height, float &x, float &y,
                     float &distance) {
    auto q = conjugate(panel.orientation);
    auto p = rotate(q, subtract(ray.position, panel.position));
    auto d = rotate(q, rotate(ray.orientation, {0, 0, -1}));
    if (d.z >= -0.0001f)
        return false;
    distance = -p.z / d.z;
    if (distance <= 0 || distance > 10)
        return false;
    x = (p.x + d.x * distance) / width + .5f;
    y = .5f - (p.y + d.y * distance) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}
} // namespace office
