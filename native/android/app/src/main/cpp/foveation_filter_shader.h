#pragma once
// Filtered reconstruction of the runtime's scaled-bin foveation: GLSL and the matching
// host-testable math. No GL or OpenXR headers, so the shader check suite can dump and validate
// these stages on the host.
//
// GL_QCOM_texture_foveated renders each bin of a scaled-bin texture at a reduced density and
// "finally upscal[es] the subregion to the native texture resolution" (issue 2); the Galaxy XR
// driver does that by repeating each low-density pixel, so the periphery shows hard blocks. The
// documented alternative that samples low-density regions with bilinear filtering is a
// subsampled layout ("Reduces aliasing in peripheral areas through bilinear filtering",
// https://developer.android.com/develop/xr/unity/performance/androidxr-extension-settings), which
// OpenXR offers only for Vulkan swapchains. So the world renders into a runtime-foveated
// swapchain that is never submitted, and this pass rebuilds the submitted, unfoveated image from
// it: full-density pixels are copied, and every reduced region is filtered over the width of its
// own blocks, which is what a bilinear upscale of the low-density pixels gives.
// https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string>

namespace office {
/**
 * Neighbour steps (in full-resolution pixels, so 1/density) are stored in the world image's alpha
 * in steps of a half pixel, four bits per axis: 1 to 8.5 pixels. QCOM issue 4: "gl_FragCoord
 * will be scaled to match the relative location in a foveated texture" while dFdx/dFdy "will have
 * no corrective scaling", so dFdx(gl_FragCoord.x) is the step between neighbouring invocations.
 * The projection layer of the world has no alpha blending, so its alpha is free for this.
 */
constexpr float kDensityStepQuantum = .5f;
constexpr int kDensityStepLevels = 16;

inline int densityStepLevel(float step) {
    if (!std::isfinite(step))
        return kDensityStepLevels - 1;
    const float level = std::floor((std::abs(step) - 1.f) / kDensityStepQuantum + .5f);
    return static_cast<int>(std::clamp(level, 0.f, float(kDensityStepLevels - 1)));
}

/** The alpha code for a fragment's horizontal and vertical neighbour steps. */
inline uint8_t encodeDensitySteps(float stepX, float stepY) {
    return static_cast<uint8_t>(densityStepLevel(stepX) * kDensityStepLevels +
                                densityStepLevel(stepY));
}

inline std::array<float, 2> decodeDensitySteps(uint8_t code) {
    return {1.f + float(code / kDensityStepLevels) * kDensityStepQuantum,
            1.f + float(code % kDensityStepLevels) * kDensityStepQuantum};
}

/**
 * Bilinear taps along one axis for a block width. A full-density axis (below 1.25) takes one
 * centred tap, so full-density pixels are copied exactly; two taps rebuild a half-density axis
 * exactly; wider blocks take three, which keeps every step between output pixels at a third of
 * the edge or less up to 8.5-pixel blocks.
 */
constexpr int kMaxFilterTaps = 3;
inline int filterTaps(float step) {
    if (!(step >= 1.25f))
        return 1;
    return step < 2.25f ? 2 : kMaxFilterTaps;
}

/** Where tap i of n sits, in pixels from the pixel centre, for a block width of step. */
inline float filterTapOffset(int i, int n, float step) {
    return n <= 1 ? 0.f : ((float(i) + .5f) / float(n) - .5f) * step;
}

struct FoveationFilterShaders {
    std::string vertex, densityFragment, resolveFragment;
};

/**
 * vertex: a full-screen triangle (multiview: both views, the layer from gl_ViewID_OVR).
 * densityFragment: drawn last into the foveated world framebuffer with only alpha written; each
 * invocation stores its measured neighbour steps (encodeDensitySteps). resolveFragment: drawn
 * into the submitted image, reading the foveated world image (unit 0, linear filtering).
 */
inline FoveationFilterShaders foveationFilterShaders(bool multiview) {
    const auto number = [](float v) { return std::to_string(v); };
    FoveationFilterShaders s;
    s.vertex = "#version 300 es\n";
    if (multiview)
        s.vertex += "#extension GL_OVR_multiview2 : require\nlayout(num_views = 2) in;\n";
    s.vertex += "flat out int layer;\n"
                "void main() {\n"
                "    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n";
    s.vertex += multiview ? "    layer = int(gl_ViewID_OVR);\n" : "    layer = 0;\n";
    s.vertex += "    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
                "}\n";

    const std::string levels = number(float(kDensityStepLevels));
    s.densityFragment = "#version 300 es\n"
                        "precision highp float;\n"
                        "flat in int layer;\n"
                        "out vec4 pixel;\n"
                        "void main() {\n"
                        "    vec2 fc = gl_FragCoord.xy;\n"
                        "    vec2 stepPx = abs(vec2(dFdx(fc.x), dFdy(fc.y)));\n"
                        "    vec2 level = clamp(floor((stepPx - 1.0) / " +
                        number(kDensityStepQuantum) + " + 0.5), 0.0, " +
                        number(float(kDensityStepLevels - 1)) +
                        ");\n"
                        "    pixel = vec4(0.0, 0.0, 0.0, (level.x * " +
                        levels +
                        " + level.y) / 255.0);\n"
                        "}\n";

    const std::string sampler = multiview ? "sampler2DArray" : "sampler2D";
    const std::string at = multiview ? "vec3(uv, float(layer))" : "uv";
    const std::string texel = multiview ? "ivec3(p, layer)" : "p";
    s.resolveFragment =
        "#version 300 es\n"
        "precision highp float;\n"
        "precision highp int;\n"
        "precision highp " +
        sampler +
        ";\n"
        "uniform " +
        sampler +
        " source;\n"
        "flat in int layer;\n"
        "out vec4 pixel;\n"
        "int taps(float stepPx) {\n"
        "    return stepPx < 1.25 ? 1 : (stepPx < 2.25 ? 2 : " +
        std::to_string(kMaxFilterTaps) +
        ");\n"
        "}\n"
        "float offset(int i, int n, float stepPx) {\n"
        "    return n <= 1 ? 0.0 : ((float(i) + 0.5) / float(n) - 0.5) * stepPx;\n"
        "}\n"
        "void main() {\n"
        "    ivec2 p = ivec2(gl_FragCoord.xy);\n"
        "    vec4 c = texelFetch(source, " +
        texel +
        ", 0);\n"
        "    int code = int(c.a * 255.0 + 0.5);\n"
        "    vec2 stepPx = 1.0 + vec2(float(code / " +
        std::to_string(kDensityStepLevels) + "), float(code - (code / " +
        std::to_string(kDensityStepLevels) + ") * " + std::to_string(kDensityStepLevels) + ")) * " +
        number(kDensityStepQuantum) +
        ";\n"
        "    ivec2 n = ivec2(taps(stepPx.x), taps(stepPx.y));\n"
        "    if (n.x == 1 && n.y == 1) {\n"
        "        pixel = vec4(c.rgb, 1.0);\n"
        "        return;\n"
        "    }\n"
        "    vec2 texelSize = 1.0 / vec2(textureSize(source, 0).xy);\n"
        "    vec3 sum = vec3(0.0);\n"
        "    for (int j = 0; j < " +
        std::to_string(kMaxFilterTaps) +
        "; ++j) {\n"
        "        if (j >= n.y) break;\n"
        "        float dy = offset(j, n.y, stepPx.y);\n"
        "        for (int i = 0; i < " +
        std::to_string(kMaxFilterTaps) +
        "; ++i) {\n"
        "            if (i >= n.x) break;\n"
        "            vec2 uv = (gl_FragCoord.xy + vec2(offset(i, n.x, stepPx.x), dy)) * "
        "texelSize;\n"
        "            sum += texture(source, " +
        at +
        ").rgb;\n"
        "        }\n"
        "    }\n"
        "    pixel = vec4(sum / float(n.x * n.y), 1.0);\n"
        "}\n";
    return s;
}
} // namespace office
