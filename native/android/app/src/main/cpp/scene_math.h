// Small column-major matrix and bounds helpers for the native scene renderer. Header-only and
// GL-free, so the host tests use the same code as the device.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace office::scene {

using Mat4 = std::array<float, 16>;   // column-major, as three.js and OpenGL
using Affine = std::array<float, 12>; // columns 0-3 of an affine 4x4 without the last row

struct Vec3 {
    float x = 0, y = 0, z = 0;
};

inline Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 operator*(Vec3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline float length(Vec3 a) { return std::sqrt(dot(a, a)); }

/** A bounding sphere; radius < 0 is empty, radius = infinity is "always visible". */
struct Sphere {
    Vec3 c;
    float r = -1;
    bool empty() const { return !(r >= 0); }
    bool infinite() const { return std::isinf(r); }
};

inline Mat4 identity() { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

inline Mat4 multiply(const Mat4 &a, const Mat4 &b) {
    Mat4 r{};
    for (int c = 0; c < 4; c++)
        for (int row = 0; row < 4; row++) {
            float s = 0;
            for (int k = 0; k < 4; k++)
                s += a[k * 4 + row] * b[c * 4 + k];
            r[c * 4 + row] = s;
        }
    return r;
}

inline Mat4 fromAffine(const float *m) {
    return {m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1};
}

inline Vec3 transformPoint(const float *affine, Vec3 p) {
    return {affine[0] * p.x + affine[3] * p.y + affine[6] * p.z + affine[9],
            affine[1] * p.x + affine[4] * p.y + affine[7] * p.z + affine[10],
            affine[2] * p.x + affine[5] * p.y + affine[8] * p.z + affine[11]};
}

/** The largest axis scale of an affine matrix (three's Matrix4.getMaxScaleOnAxis). */
inline float maxScale(const float *a) {
    float sx = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    float sy = a[3] * a[3] + a[4] * a[4] + a[5] * a[5];
    float sz = a[6] * a[6] + a[7] * a[7] + a[8] * a[8];
    return std::sqrt(std::max(sx, std::max(sy, sz)));
}

inline Sphere transformSphere(const float *affine, const Sphere &s) {
    if (s.empty() || s.infinite())
        return s;
    return {transformPoint(affine, s.c), s.r * maxScale(affine)};
}

/** The smallest sphere around both (Sphere.union in three). */
inline Sphere unite(const Sphere &a, const Sphere &b) {
    if (a.empty())
        return b;
    if (b.empty())
        return a;
    if (a.infinite() || b.infinite())
        return {a.c, INFINITY};
    Vec3 d = b.c - a.c;
    float dist = length(d);
    if (dist + b.r <= a.r)
        return a;
    if (dist + a.r <= b.r)
        return b;
    float r = (dist + a.r + b.r) * 0.5f;
    Vec3 c = dist > 0 ? a.c + d * ((r - a.r) / dist) : a.c;
    return {c, r};
}

/** General 4x4 inverse; returns false for a singular matrix. */
inline bool invert(const Mat4 &m, Mat4 &out) {
    const float *a = m.data();
    float inv[16];
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] +
             a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] -
             a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] +
             a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] -
              a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] -
             a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] +
             a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] -
             a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] +
              a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] +
             a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] -
             a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] +
              a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] -
              a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] -
             a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] +
             a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] -
              a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] +
              a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    float det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    if (det == 0 || !std::isfinite(det))
        return false;
    float k = 1.0f / det;
    for (int i = 0; i < 16; i++)
        out[i] = inv[i] * k;
    return true;
}

/** Six planes (a, b, c, d) with a*x + b*y + c*z + d >= 0 inside, from a view-projection matrix. */
struct Frustum {
    std::array<std::array<float, 4>, 6> p{};

    static Frustum fromViewProj(const Mat4 &m) {
        Frustum f;
        auto row = [&](int r, int c) { return m[c * 4 + r]; };
        for (int i = 0; i < 3; i++) {
            for (int s = 0; s < 2; s++) {
                float sign = s == 0 ? 1.0f : -1.0f;
                auto &pl = f.p[i * 2 + s];
                for (int c = 0; c < 4; c++)
                    pl[c] = row(3, c) + sign * row(i, c);
                float n = std::sqrt(pl[0] * pl[0] + pl[1] * pl[1] + pl[2] * pl[2]);
                if (n > 0)
                    for (auto &v : pl)
                        v /= n;
            }
        }
        return f;
    }

    bool intersects(const Sphere &s) const {
        if (s.infinite())
            return true;
        if (s.empty())
            return false;
        for (const auto &pl : p)
            if (pl[0] * s.c.x + pl[1] * s.c.y + pl[2] * s.c.z + pl[3] < -s.r)
                return false;
        return true;
    }
};

/** IEEE half from float (round to nearest even), for vertex colors. */
inline uint16_t toHalf(float f) {
    uint32_t x;
    std::memcpy(&x, &f, 4);
    uint32_t sign = (x >> 16) & 0x8000u;
    int32_t exp = int32_t((x >> 23) & 0xff) - 127 + 15;
    uint32_t mant = x & 0x7fffffu;
    if (((x >> 23) & 0xff) == 0xff)
        return uint16_t(sign | 0x7c00u | (mant ? 0x200u : 0));
    if (exp <= 0) {
        if (exp < -10)
            return uint16_t(sign);
        mant |= 0x800000u;
        uint32_t shift = uint32_t(14 - exp);
        uint32_t half = mant >> shift;
        uint32_t rem = mant & ((1u << shift) - 1);
        uint32_t mid = 1u << (shift - 1);
        if (rem > mid || (rem == mid && (half & 1)))
            half++;
        return uint16_t(sign | half);
    }
    if (exp >= 31)
        return uint16_t(sign | 0x7c00u);
    uint32_t half = sign | (uint32_t(exp) << 10) | (mant >> 13);
    uint32_t rem = mant & 0x1fffu;
    if (rem > 0x1000u || (rem == 0x1000u && (half & 1)))
        half++;
    return uint16_t(half);
}

/** A normal as GL_INT_2_10_10_10_REV, normalized. */
inline uint32_t packNormal(float x, float y, float z) {
    auto q = [](float v) {
        v = std::max(-1.0f, std::min(1.0f, std::isfinite(v) ? v : 0.0f));
        return uint32_t(int32_t(std::lround(v * 511.0f)) & 0x3ff);
    };
    return q(x) | (q(y) << 10) | (q(z) << 20);
}

} // namespace office::scene
