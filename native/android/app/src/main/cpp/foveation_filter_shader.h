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
// swapchain, and this pass rebuilds the submitted, unfoveated image from it: full-density pixels
// are copied, and the low-density pixels of every reduced bin are upsampled bilinearly between
// their own centres, which is what a subsampled layout's bilinear filtering does.
// https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

namespace office {
/**
 * The density pass stores, per axis, which block of the driver's upscale a pixel belongs to: the
 * block width (the step between neighbouring invocations, 1/density) and where blocks start. QCOM
 * issue 4: "gl_FragCoord will be scaled to match the relative location in a foveated texture"
 * while dFdx/dFdy "will have no corrective scaling", so |dFdx(gl_FragCoord.x)| is the block width
 * and gl_FragCoord the invocation's place in the full-resolution image. Every pixel of a block
 * receives its invocation's code, so the resolve knows the block of each pixel without searching.
 *
 * One 4-bit code per axis (x in the high nibble of the world image's alpha, which the opaque
 * projection layer ignores): 0 full density; width - 1 + phase for blocks of 2, 4 or 8 pixels
 * starting at phase (mod width), i.e. 1-2, 3-6 and 7-14; kDensityUnknown for any other width or a
 * start off the pixel grid. QCOM lets an implementation "decimate to a fixed number of supported
 * quality levels"; on Galaxy XR the diagnostic view showed steps of 1, 2 and 4 or more almost
 * everywhere.
 */
constexpr int kDensityUnknown = 15;
constexpr int kDensityCodeLevels = 16;

/** Width and phase of one axis's code; width 0 for kDensityUnknown. */
struct DensityAxis {
    int width = 1, phase = 0;
};

/** The block width the code can describe for a measured step, or 0. */
inline int densityBlockWidth(float step) {
    if (!(step < 12.f))
        return 0;
    const float width = step < 1.25f ? 1.f : (step < 3.f ? 2.f : (step < 6.f ? 4.f : 8.f));
    if (width > 1.f && !(std::abs(step - width) <= .01f * width))
        return 0;
    return int(width);
}

/**
 * The code of one axis for an invocation at fragCoord with neighbour step `step` (both in
 * full-resolution pixels), as densityFragment computes it. The block starts half a block before
 * the invocation's scaled position (its centre) or, if the implementation scales to the centre of
 * the block's first pixel instead, half a pixel before it; whichever lands on the pixel grid is
 * used. Below 1.25 the axis is full density, so the fovea is always copied.
 */
inline int densityAxisCode(float fragCoord, float step) {
    const int width = densityBlockWidth(std::abs(step));
    if (width == 1)
        return 0;
    if (width == 0 || !std::isfinite(fragCoord))
        return kDensityUnknown;
    const float centred = fragCoord - .5f * float(width), first = fragCoord - .5f;
    const float centredStart = std::floor(centred + .5f), firstStart = std::floor(first + .5f);
    const float centredOff = std::abs(centred - centredStart),
                firstOff = std::abs(first - firstStart);
    if (std::min(centredOff, firstOff) > .0625f)
        return kDensityUnknown;
    const float start = centredOff <= firstOff ? centredStart : firstStart;
    const float phase = start - float(width) * std::floor(start / float(width));
    return width - 1 + int(phase + .5f);
}

inline DensityAxis decodeDensityAxis(int code) {
    if (code <= 0)
        return {1, 0};
    if (code >= kDensityUnknown)
        return {0, 0};
    const int width = code < 3 ? 2 : (code < 7 ? 4 : 8);
    return {width, code - (width - 1)};
}

/** The world image's alpha code: x in the high nibble. Full density on both axes is 0. */
inline uint8_t encodeDensityCode(int codeX, int codeY) {
    return static_cast<uint8_t>(codeX * kDensityCodeLevels + codeY);
}

/**
 * Where the resolve's one linear tap sits along an axis, in pixels, for pixel x: the bilinear
 * blend of the pixel's own block and the nearer neighbouring block, weighted by the distance
 * between their centres. Both blocks are constant, so a linear tap between the last pixel of one
 * and the first of the other gives exactly that blend. Full density (and an unknown axis) taps
 * the pixel's own centre: no resampling.
 */
inline float densityTapCoordinate(int x, DensityAxis axis) {
    if (axis.width <= 1)
        return float(x) + .5f;
    const float width = float(axis.width);
    // x - phase + 8 is never negative (phase < width <= 8) and 8 is a multiple of every width.
    const int start = x - (x - axis.phase + 8) % axis.width;
    const float d = float(x) + .5f - (float(start) + .5f * width);
    return d >= 0 ? float(start) + width - .5f + d / width : float(start) + .5f + d / width;
}

struct FoveationFilterShaders {
    std::string vertex, densityFragment, resolveFragment;
};

/** GLSL of densityAxisCode, shared by the density pass and the host checks. */
inline std::string densityAxisCodeGlsl() {
    return "int axisCode(float fc, float stepPx) {\n"
           "    if (!(stepPx < 12.0)) return 15;\n"
           "    float width = stepPx < 1.25 ? 1.0 : (stepPx < 3.0 ? 2.0 : (stepPx < 6.0 ? 4.0 : "
           "8.0));\n"
           "    if (width == 1.0) return 0;\n"
           "    if (!(abs(stepPx - width) <= 0.01 * width)) return 15;\n"
           "    float centred = fc - 0.5 * width;\n"
           "    float first = fc - 0.5;\n"
           "    float centredStart = floor(centred + 0.5);\n"
           "    float firstStart = floor(first + 0.5);\n"
           "    float centredOff = abs(centred - centredStart);\n"
           "    float firstOff = abs(first - firstStart);\n"
           "    if (min(centredOff, firstOff) > 0.0625) return 15;\n"
           "    float start = centredOff <= firstOff ? centredStart : firstStart;\n"
           "    float phase = start - width * floor(start / width);\n"
           "    return int(width) - 1 + int(phase + 0.5);\n"
           "}\n";
}

/**
 * vertex: a full-screen triangle (multiview: both views, the layer from gl_ViewID_OVR).
 * densityFragment: drawn last into the foveated world framebuffer with only alpha written; each
 * invocation stores its axis codes (densityAxisCode). resolveFragment: drawn into the submitted
 * image, reading the foveated world image (unit 0, linear filtering): a copy at full density, one
 * bilinear tap (densityTapCoordinate on both axes) in reduced bins, and a [1 2 1] / 4 smoothing
 * along an axis whose blocks the code could not describe.
 */
inline FoveationFilterShaders foveationFilterShaders(bool multiview) {
    const std::string levels = std::to_string(kDensityCodeLevels);
    const std::string unknown = std::to_string(kDensityUnknown);
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

    s.densityFragment = "#version 300 es\n"
                        "precision highp float;\n"
                        "precision highp int;\n"
                        "flat in int layer;\n"
                        "out vec4 pixel;\n" +
                        densityAxisCodeGlsl() +
                        "void main() {\n"
                        "    vec2 fc = gl_FragCoord.xy;\n"
                        "    vec2 stepPx = abs(vec2(dFdx(fc.x), dFdy(fc.y)));\n"
                        "    int code = axisCode(fc.x, stepPx.x) * " +
                        levels +
                        " + axisCode(fc.y, stepPx.y);\n"
                        "    pixel = vec4(0.0, 0.0, 0.0, float(code) / 255.0);\n"
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
        "float axisTap(int x, int code) {\n"
        "    if (code <= 0 || code >= " +
        unknown +
        ") return float(x) + 0.5;\n"
        "    int width = code < 3 ? 2 : (code < 7 ? 4 : 8);\n"
        "    int phase = code - (width - 1);\n"
        "    int start = x - (x - phase + 8) % width;\n"
        "    float w = float(width);\n"
        "    float d = float(x) + 0.5 - (float(start) + 0.5 * w);\n"
        "    return d >= 0.0 ? float(start) + w - 0.5 + d / w : float(start) + 0.5 + d / w;\n"
        "}\n"
        "vec3 tap(vec2 atPx, vec2 texelSize) {\n"
        "    vec2 uv = atPx * texelSize;\n"
        "    return texture(source, " +
        at +
        ").rgb;\n"
        "}\n"
        "void main() {\n"
        "    ivec2 p = ivec2(gl_FragCoord.xy);\n"
        "    vec4 c = texelFetch(source, " +
        texel +
        ", 0);\n"
        "    int code = int(c.a * 255.0 + 0.5);\n"
        "    if (code == 0) {\n"
        "        pixel = vec4(c.rgb, 1.0);\n"
        "        return;\n"
        "    }\n"
        "    int cx = code / " +
        levels +
        ";\n"
        "    int cy = code - cx * " +
        levels +
        ";\n"
        "    vec2 texelSize = 1.0 / vec2(textureSize(source, 0).xy);\n"
        "    vec2 atPx = vec2(axisTap(p.x, cx), axisTap(p.y, cy));\n"
        "    if (cx != " +
        unknown + " && cy != " + unknown +
        ") {\n"
        "        pixel = vec4(tap(atPx, texelSize), 1.0);\n"
        "        return;\n"
        "    }\n"
        "    vec2 spread = vec2(cx == " +
        unknown + " ? 0.5 : 0.0, cy == " + unknown +
        " ? 0.5 : 0.0);\n"
        "    vec3 sum = tap(atPx - spread, texelSize) + tap(atPx + spread, texelSize) +\n"
        "        tap(atPx + vec2(spread.x, -spread.y), texelSize) +\n"
        "        tap(atPx + vec2(-spread.x, spread.y), texelSize);\n"
        "    pixel = vec4(sum * 0.25, 1.0);\n"
        "}\n";
    return s;
}
} // namespace office
