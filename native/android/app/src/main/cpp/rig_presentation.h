#pragma once
#include "bridge_state.h"
#include <algorithm>
#include <cmath>

namespace office {
/**
 * Render-thread presentation of the authoritative 30 Hz rig, using bounded interpolation.
 * It never predicts another player position or delays the native eye/hand pose. Normal
 * motion runs about one bridge interval behind; discontinuity epochs, tracking loss and
 * stale/restarted producers rebase immediately. World-space hover points stay world-space.
 */
class RigPresentation {
  public:
    void reset() { initialized = false; }

    void present(ControlState &control, double nowMs, bool focused) {
        XrPosef incoming;
        const bool rigid = pose(control.rig, incoming);
        const float fade =
            std::isfinite(control.fade) ? std::clamp(control.fade, 0.f, 1.f) : latestFade;
        const double receivedMs = static_cast<double>(control.receivedNs) / 1e6;
        const bool clockValid =
            std::isfinite(nowMs) && control.receivedNs > 0 && receivedMs <= nowMs + 1;
        const bool stale = !clockValid || nowMs - receivedMs > staleMs;
        if (!rigid) {
            // A finite but scaled/sheared/reflected matrix is not a camera rig. Keep
            // the last proper pose, and require a fresh baseline before smoothing.
            initialized = false;
            control.rig = transform(presented);
            control.fade = fade;
            return;
        }
        if (!initialized || !focused || !control.active || stale || !wasFocused || !wasActive ||
            nowMs < observedMs) {
            adopt(control, incoming, fade, nowMs, receivedMs, focused, stale);
            control.rig = transform(presented);
            control.fade = latestFade;
            return;
        }

        auto current = blend(start, target, amount(nowMs, startedMs, rigDurationMs));
        float currentFade = mix(startFade, latestFade, amount(nowMs, startedMs, fadeDurationMs));
        if (control.revision != revision) {
            const double interval = receivedMs - receiptMs;
            const double observedInterval = nowMs - observedMs;
            // The epoch covers even tiny teleports and every snap. The guards also
            // protect legacy producers, dropped samples and unexpected tracking jumps.
            const bool discontinuous =
                control.presentationEpoch != epoch || control.revision < revision || wasStale ||
                interval < 0 || interval > maxIntervalMs || observedInterval > maxIntervalMs ||
                distance(target.position, incoming.position) > .5f ||
                std::abs(target.position.y - incoming.position.y) > .25f ||
                angularDistance(target.orientation, incoming.orientation) >
                    .2617994f; // 15 degrees; original snaps are 45 degrees.
            const double duration = std::clamp(interval, minIntervalMs, maxBlendMs);
            start = discontinuous ? incoming : current;
            target = incoming;
            startFade = currentFade;
            latestFade = fade;
            startedMs = nowMs;
            rigDurationMs = discontinuous ? 0 : duration;
            fadeDurationMs = duration;
            // The authoritative blink moves at full black. Never delay black behind
            // its rig jump, or interpolate through the teleport/elevator placement.
            if (fade >= 1.f) {
                startFade = 1;
                fadeDurationMs = 0;
            }
            revision = control.revision;
            epoch = control.presentationEpoch;
            observedMs = nowMs;
            receiptMs = receivedMs;
            current = blend(start, target, amount(nowMs, startedMs, rigDurationMs));
            currentFade = mix(startFade, latestFade, amount(nowMs, startedMs, fadeDurationMs));
        }
        presented = current;
        wasFocused = focused;
        wasActive = control.active;
        wasStale = false;
        control.rig = transform(presented);
        control.fade = currentFade;
    }

  private:
    static constexpr double staleMs = 100, minIntervalMs = 1000. / 90., maxIntervalMs = 70,
                            maxBlendMs = 50;
    bool initialized = false, wasFocused = false, wasActive = false, wasStale = false;
    uint64_t revision = 0;
    uint32_t epoch = 0;
    XrPosef start{{0, 0, 0, 1}, {0, 0, 0}}, target = start, presented = start;
    float startFade = 0, latestFade = 0;
    double observedMs = 0, receiptMs = 0, startedMs = 0, rigDurationMs = 0, fadeDurationMs = 0;

    static float mix(float a, float b, float t) { return a + (b - a) * t; }
    static float amount(double now, double from, double duration) {
        return duration > 0 ? static_cast<float>(std::clamp((now - from) / duration, 0., 1.)) : 1.f;
    }
    static float dot(XrVector3f a, XrVector3f b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    static float distance(XrVector3f a, XrVector3f b) {
        auto d = subtract(a, b);
        return std::sqrt(dot(d, d));
    }
    static float dot(XrQuaternionf a, XrQuaternionf b) {
        return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    }
    static XrQuaternionf normalized(XrQuaternionf q) {
        const float n = std::sqrt(dot(q, q));
        return {q.x / n, q.y / n, q.z / n, q.w / n};
    }
    static float angularDistance(XrQuaternionf a, XrQuaternionf b) {
        return 2 * std::acos(std::clamp(std::abs(dot(a, b)), 0.f, 1.f));
    }
    static XrPosef blend(XrPosef a, XrPosef b, float t) {
        // Shortest-path SLERP preserves rigid rotation, including the +/-pi yaw wrap.
        float cosine = dot(a.orientation, b.orientation);
        if (cosine < 0) {
            b.orientation = {-b.orientation.x, -b.orientation.y, -b.orientation.z,
                             -b.orientation.w};
            cosine = -cosine;
        }
        cosine = std::clamp(cosine, 0.f, 1.f);
        float left = 1 - t, right = t;
        if (cosine < .9995f) {
            const float angle = std::acos(cosine), sine = std::sin(angle);
            left = std::sin((1 - t) * angle) / sine;
            right = std::sin(t * angle) / sine;
        }
        auto q = normalized({a.orientation.x * left + b.orientation.x * right,
                             a.orientation.y * left + b.orientation.y * right,
                             a.orientation.z * left + b.orientation.z * right,
                             a.orientation.w * left + b.orientation.w * right});
        return {q, add(a.position, scale(subtract(b.position, a.position), t))};
    }
    static bool pose(const Matrix &m, XrPosef &out) {
        for (float value : m)
            if (!std::isfinite(value))
                return false;
        if (std::abs(m[3]) > .0001f || std::abs(m[7]) > .0001f || std::abs(m[11]) > .0001f ||
            std::abs(m[15] - 1) > .0001f)
            return false;
        const XrVector3f x{m[0], m[1], m[2]}, y{m[4], m[5], m[6]}, z{m[8], m[9], m[10]};
        if (std::abs(dot(x, x) - 1) > .002f || std::abs(dot(y, y) - 1) > .002f ||
            std::abs(dot(z, z) - 1) > .002f || std::abs(dot(x, y)) > .002f ||
            std::abs(dot(x, z)) > .002f || std::abs(dot(y, z)) > .002f)
            return false;
        const float determinant = x.x * (y.y * z.z - y.z * z.y) - y.x * (x.y * z.z - x.z * z.y) +
                                  z.x * (x.y * y.z - x.z * y.y);
        if (determinant < .998f || determinant > 1.002f)
            return false;
        XrQuaternionf q;
        const float trace = m[0] + m[5] + m[10];
        if (trace > 0) {
            const float s = 2 * std::sqrt(trace + 1);
            q = {(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, .25f * s};
        } else if (m[0] > m[5] && m[0] > m[10]) {
            const float s = 2 * std::sqrt(1 + m[0] - m[5] - m[10]);
            q = {.25f * s, (m[4] + m[1]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s};
        } else if (m[5] > m[10]) {
            const float s = 2 * std::sqrt(1 + m[5] - m[0] - m[10]);
            q = {(m[4] + m[1]) / s, .25f * s, (m[9] + m[6]) / s, (m[8] - m[2]) / s};
        } else {
            const float s = 2 * std::sqrt(1 + m[10] - m[0] - m[5]);
            q = {(m[8] + m[2]) / s, (m[9] + m[6]) / s, .25f * s, (m[1] - m[4]) / s};
        }
        out = {normalized(q), {m[12], m[13], m[14]}};
        return true;
    }
    void adopt(const ControlState &control, XrPosef pose, float fade, double now, double received,
               bool focused, bool stale) {
        start = target = presented = pose;
        startFade = latestFade = fade;
        startedMs = observedMs = now;
        receiptMs = received;
        rigDurationMs = fadeDurationMs = 0;
        revision = control.revision;
        epoch = control.presentationEpoch;
        wasFocused = focused;
        wasActive = control.active;
        wasStale = stale;
        initialized = true;
    }
};
} // namespace office
