#pragma once
// The foveation diagnostic view: GLSL and the matching host-testable math. No GL or OpenXR
// headers, so the shader check suite can dump and validate these stages on the host.
#include <algorithm>
#include <array>
#include <cmath>
#include <string>

namespace office {
/**
 * Upper edges of the density bands, in full-resolution pixels between neighbouring fragments:
 * full (1), half (2), a third (3), and a quarter or less. GL_QCOM_texture_foveated issue 4
 * scales gl_FragCoord to full-resolution positions inside a scaled bin and applies no corrective
 * scaling to dFdx/dFdy, so the step between neighbouring invocations is 1/density.
 * https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt
 * Reading density this way is derived from that issue text; it is not a documented debug tool.
 */
constexpr std::array<float, 3> kDensityBandEdges{1.25f, 2.5f, 3.5f};

/** 0 = full density, 1 = half, 2 = a third, 3 = a quarter or less. Non-finite reads as lowest. */
inline int densityBand(float step) {
    if (!std::isfinite(step))
        return 3;
    step = std::abs(step);
    int band = 0;
    while (band < 3 && step >= kDensityBandEdges[band])
        ++band;
    return band;
}

/**
 * XrFoveationEyeTrackedStateMETA::foveationCenter is "the center of the foveal region defined in
 * NDC space in the range of -1 to 1" (XR_META_foveation_eye_tracked). The axis convention for a
 * GL image is not documented; this uses GL's (x right, y up, image origin bottom-left, as the
 * projection layer's imageRect). A mirrored marker on the device would show the opposite.
 */
inline std::array<float, 2> foveaPixel(float x, float y, int width, int height) {
    const auto unit = [](float v) { return std::isfinite(v) ? std::clamp(v, -1.f, 1.f) : 0.f; };
    return {(unit(x) * .5f + .5f) * width, (unit(y) * .5f + .5f) * height};
}

/** The marker ring around a reported centre, as fractions of the shorter eye-image side. */
constexpr float kFoveaRingRadius = .05f, kFoveaRingWidth = .005f, kFoveaDotRadius = .01f;

struct FoveationOverlayShader {
    std::string vertex, fragment;
};

/**
 * A full-screen pass drawn last into the foveated world framebuffer. Its fragments run at the
 * runtime's actual per-bin density: the colour shows the measured neighbour step, and a
 * one-pixel checker can only be resolved at full density (coarser bins upscale it into solid
 * blocks). The magenta ring marks the runtime-reported centre; it is computed, not measured.
 */
inline FoveationOverlayShader foveationOverlayShader(bool multiview) {
    const auto number = [](float v) { return std::to_string(v); };
    FoveationOverlayShader s;
    s.vertex = "#version 300 es\n";
    if (multiview)
        s.vertex += "#extension GL_OVR_multiview2 : require\nlayout(num_views = 2) in;\n";
    else
        s.vertex += "uniform int eye;\n";
    s.vertex += "flat out int view;\n"
                "void main() {\n"
                "    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n";
    s.vertex += multiview ? "    view = int(gl_ViewID_OVR);\n" : "    view = eye;\n";
    s.vertex += "    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
                "}\n";
    s.fragment = "#version 300 es\n"
                 "precision highp float;\n"
                 "flat in int view;\n"
                 "uniform vec2 size;\n"
                 "uniform vec4 centers;\n"
                 "uniform int centerValid;\n"
                 "out vec4 pixel;\n"
                 "void main() {\n"
                 "    vec2 fc = gl_FragCoord.xy;\n"
                 "    float stepPx = max(abs(dFdx(fc.x)), abs(dFdy(fc.y)));\n"
                 "    vec3 tint = stepPx < " +
                 number(kDensityBandEdges[0]) +
                 " ? vec3(0.1, 1.0, 0.25)\n"
                 "        : stepPx < " +
                 number(kDensityBandEdges[1]) +
                 " ? vec3(1.0, 0.85, 0.1)\n"
                 "        : stepPx < " +
                 number(kDensityBandEdges[2]) +
                 " ? vec3(1.0, 0.45, 0.05) : vec3(1.0, 0.1, 0.1);\n"
                 "    float parity = mod(floor(fc.x) + floor(fc.y), 2.0);\n"
                 "    vec3 color = tint * (0.3 + 0.7 * parity);\n"
                 "    float alpha = 0.55;\n"
                 "    if (centerValid != 0) {\n"
                 "        vec2 c = clamp(view == 0 ? centers.xy : centers.zw, -1.0, 1.0);\n"
                 "        vec2 at = (c * 0.5 + 0.5) * size;\n"
                 "        float unit = min(size.x, size.y);\n"
                 "        float r = length(fc - at);\n"
                 "        if (abs(r - " +
                 number(kFoveaRingRadius) + " * unit) < " + number(kFoveaRingWidth) +
                 " * unit || r < " + number(kFoveaDotRadius) +
                 " * unit) {\n"
                 "            color = vec3(1.0, 0.0, 1.0);\n"
                 "            alpha = 0.9;\n"
                 "        }\n"
                 "    }\n"
                 "    pixel = vec4(color, alpha);\n"
                 "}\n";
    return s;
}
} // namespace office
