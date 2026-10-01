// GLSL ES 3.00 programs that draw the office the way three.js r186 draws it in the browser,
// including the patch world/sky.ts adds to every material. Attribute locations, texture units and
// the std140 uniform blocks come from scene_uniforms.h. GL-free, so host tests include it too.
#pragma once

#include <cstdint>
#include <string>

namespace office::scene {

enum class ShadeModel : uint8_t {
    Basic,    // MeshBasicMaterial
    Toon,     // MeshToonMaterial (almost everything in the office)
    Lambert,  // MeshLambertMaterial
    Phong,    // MeshPhongMaterial
    Standard, // MeshStandardMaterial (the MacBook GLBs, a few VR props)
    Points,   // PointsMaterial (stars, halos, snow, lamps)
    Line,    // LineBasicMaterial (rain, laser lines, cords); also wireframe draws of any unlit mesh
    Sprite,  // SpriteMaterial (labels, speech-bubble cards)
    Beam,    // world/rooftop.ts beamMaterial() ShaderMaterial
    SkyDome, // world/sky.ts gradientDome() ShaderMaterial
    Depth,   // shadow map pass (single view, no color output)
};

enum class FogMode : uint8_t { None, Linear, Exp2 };

/**
 * The high-resolution screen layer's variants sample the world pass's depth texture (texture unit
 * kUnitSharpDepth) to keep what the world shows in front of them. None is every world-pass program.
 */
enum class SharpDepth : uint8_t { None, Texture2D, Array };

struct ProgramKey {
    ShadeModel model = ShadeModel::Basic;
    bool multiview = false; // GL_OVR_multiview2, num_views = 2, index View by gl_ViewID_OVR
    bool linearOutput =
        true; // target is sRGB (GL_SRGB8_ALPHA8): write linear (see "Color pipeline")
    FogMode fog = FogMode::None; // scene fog applies (material.fog && scene.fog)
    bool sky = false; // world/sky.ts patch applies (haze instead of plain linear fog; on lit models
                      // also wet/snow/lamps)
    bool map = false, alphaMap = false, emissiveMap = false, gradientMap = false;
    bool alphaTest = false; // discard below uAlphaTest
    bool opaque =
        false; // three's OPAQUE define: transparent == false && blending == Normal -> alpha = 1
    bool premultipliedAlpha = false;
    bool doubleSided = false; // DoubleSide: flip the normal on back faces (gl_FrontFacing)
    bool backSide = false;    // BackSide: FLIP_SIDED, normal negated
    bool shadows = false; // sample uShadowMap for the shadowed directional light (lit models only)
    bool flatShading = false;
    bool sizeAttenuation = true; // Points and Sprite
    // Screen layer (not Depth, Beam or SkyDome). A screen fragment is discarded where the world
    // depth is nearer, and writes (color * uSharpParams.w, 1). An overlay fragment (a surface the
    // world depth does not hold, drawn over the screens) is discarded where the world depth is
    // farther than it, and writes premultiplied color for a destination-alpha blend.
    SharpDepth sharpDepth = SharpDepth::None;
    bool sharpOverlay = false;

    uint32_t bits() const; // unique per distinct key (for the renderer's program cache)
    bool operator==(const ProgramKey &o) const { return bits() == o.bits(); }
};

struct ShaderSource {
    std::string vertex;
    std::string fragment;
};

/**
 * Which GLSL a program is generated in. Gles is the shipping text (GLSL ES 3.00), byte for byte as
 * before the Vulkan port. Vulkan is GLSL 4.50 for SPIR-V (KHR_vulkan_glsl, compiled by shaderc /
 * glslc): the same programs with `#version 450` and GL_EXT_multiview (gl_ViewIndex,
 * gl_VertexIndex), every block and sampler at its descriptor set and binding (scene_uniforms.h),
 * every default-block uniform in one nameless `Draw` block declared identically in both stages (so
 * the names stay), varyings at fixed locations, and the GL clip depth remapped to Vulkan's [0, w].
 * The renderer keeps GL matrices and draws swapchain passes with a negative viewport height (Vulkan
 * 1.1 / VK_KHR_maintenance1), so NDC +y is the image's top row as OpenXR expects and GL winding
 * holds; window-space y then points down, so the two fragment terms that depend on its sign (flat
 * shading's dFdy, the shadow noise's gl_FragCoord.y) are flipped back to GL's. See
 * research/vulkan-port.md 4.3 and 4.5.
 */
enum class Dialect : uint8_t { Gles, Vulkan };

/** Source for `key` in `dialect`. Deterministic; never throws. */
ShaderSource generateShader(const ProgramKey &key, Dialect dialect = Dialect::Gles);

/** A short name for logs, e.g. "toon+map+sky+fog+shadow+mv". */
std::string programName(const ProgramKey &key);

} // namespace office::scene
