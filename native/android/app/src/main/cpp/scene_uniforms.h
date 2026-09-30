// The contract between the scene renderer and its shaders: vertex attribute locations, texture
// units, and the std140 uniform blocks, as C++ structs whose layout matches the GLSL declarations
// in scene_shaders.cpp byte for byte. GL-free, so host tests include it too.
#pragma once

#include <cstddef>
#include <cstdint>

namespace office::scene {

// Vertex attribute locations (`layout(location = N) in` in every vertex shader).
enum Attribute : uint32_t {
    kAttrPosition = 0, // vec3
    kAttrNormal = 1,   // vec3 (the renderer may feed GL_INT_2_10_10_10_REV, normalized)
    kAttrUv = 2,       // vec2
    kAttrColor = 3,    // vec4 linear, material color * vertex color. Constant (1,1,1,1) when absent
    kAttrInstance0 = 4, // vec4 row 0 of the instance's 3x4 matrix. Constant (1,0,0,0) when absent
    kAttrInstance1 = 5, // vec4 row 1. Constant (0,1,0,0)
    kAttrInstance2 = 6, // vec4 row 2. Constant (0,0,1,0)
    kAttrInstanceColor = 7, // vec3 linear. Constant (1,1,1)
    kAttrCount = 8,
};

// Texture units (the renderer sets each sampler uniform to its unit once after linking).
enum TextureUnit : int32_t {
    kUnitMap = 0,         // uniform sampler2D uMap
    kUnitAlphaMap = 1,    // uniform sampler2D uAlphaMap
    kUnitEmissiveMap = 2, // uniform sampler2D uEmissiveMap
    kUnitGradientMap = 3, // uniform sampler2D uGradientMap
    kUnitShadowMap = 4,   // uniform highp sampler2DShadow uShadowMap
    kUnitSharpDepth = 5,  // uniform highp sampler2D / sampler2DArray uSharpDepth (screen layer)
};

// Uniform block bindings (glUniformBlockBinding by block name).
enum BlockBinding : uint32_t {
    kBlockFrame = 0, // "Frame"
    kBlockSky = 1,   // "Sky"
    kBlockView = 2,  // "View"
};

constexpr int kMaxHemi = 2;
constexpr int kMaxDir = 2;
constexpr int kMaxPoint = 8;
constexpr int kMaxLamps = 24;   // world/sky.ts MAX_LAMPS
constexpr int kMaxScreens = 16; // world/sky.ts MAX_SCREENS

struct alignas(16) Vec4 {
    float x = 0, y = 0, z = 0, w = 0;
};
struct alignas(16) IVec4 {
    int32_t x = 0, y = 0, z = 0, w = 0;
};
struct alignas(16) Mat4Std {
    float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; // column-major
};

/**
 * layout(std140) uniform View  (binding 2). Per view: in multiview index [gl_ViewID_OVR]; in
 * single-view mode the renderer binds a copy whose slot [0] holds the current eye and shaders
 * index [0].
 */
struct ViewBlock {
    Mat4Std viewProj[2]; // world -> clip
    Mat4Std view[2];     // world -> eye
    Mat4Std proj[2];     // eye -> clip
    Vec4 cameraPos[2];   // xyz: world eye position
    Vec4 viewport;       // x: per-eye height in pixels, y: 0.5 * height (three's points `scale`)
};

/** layout(std140) uniform Frame  (binding 0). Lights and fog, world space. */
struct FrameBlock {
    Vec4 fogColor;  // rgb: sRGB-encoded (three's fogColor on screen); w: 0 none, 1 linear, 2 exp2
    Vec4 fogParams; // x near, y far, z density
    Vec4 ambient;   // rgb: sum of ambient light color * intensity
    IVec4 counts; // x hemi, y directional, z point lights, w index of the shadowed directional (-1:
                  // none)
    Vec4 hemiSky[kMaxHemi];
    Vec4 hemiGround[kMaxHemi];
    Vec4 hemiDir[kMaxHemi];     // xyz: world up of the light, normalized
    Vec4 dirColor[kMaxDir];     // rgb: color * intensity
    Vec4 dirDir[kMaxDir];       // xyz: world direction toward the light, normalized
    Vec4 pointPos[kMaxPoint];   // xyz world, w: distance (cutoff; 0 = none)
    Vec4 pointColor[kMaxPoint]; // rgb: color * intensity, w: decay
    Mat4Std shadowMatrix;       // world -> shadow texture coordinates (three's shadow.matrix)
    Vec4 shadowParams;          // x bias, y normalBias, z radius, w intensity (0: no shadow)
    Vec4 shadowMapSize;         // xy: size in texels, zw: 1 / size
};

/** layout(std140) uniform Sky  (binding 1). world/sky.ts's uniforms and constants. */
struct SkyBlock {
    Vec4 flags;     // x skyOn, y skyInside, z skyWet, w skySnow
    Vec4 misc;      // x skyDrop, y skyStreet, z HAZE_CLEAR, w HAZE_ABOVE
    Vec4 haze;      // x HAZE_MAX, y 1 when the sky patch is present (else plain fog), zw unused
    Vec4 office;    // rgb skyOffice
    Vec4 garage;    // rgb skyGarage
    Vec4 officeMin; // xyz skyInOffice box min
    Vec4 officeMax; // xyz skyInOffice box max
    Vec4 garageBox; // x B.minX + 0.05, y B.minZ + 0.05, z B.maxX, w B.maxZ
    Vec4 garageY;   // x STREET_Y - 0.5, y -SLAB + 0.02
    IVec4 counts;   // x lamps, y screens
    Vec4 lampMin, lampMax, screenMin, screenMax;
    Vec4 lamps[kMaxLamps];        // xyz position, w reach
    Vec4 lampColors[kMaxLamps];   // rgb
    Vec4 screens[kMaxScreens];    // xyz position, w reach
    Vec4 screenDirs[kMaxScreens]; // xyz
    Vec4 screenColors[kMaxScreens];
};

static_assert(sizeof(ViewBlock) == 432, "View std140 size");
static_assert(offsetof(ViewBlock, cameraPos) == 384 && offsetof(ViewBlock, viewport) == 416,
              "View std140 offsets");
static_assert(offsetof(FrameBlock, counts) == 48 && offsetof(FrameBlock, hemiSky) == 64,
              "Frame std140 offsets");
static_assert(offsetof(FrameBlock, pointPos) == 224 && offsetof(FrameBlock, shadowMatrix) == 480,
              "Frame std140 offsets");
static_assert(sizeof(FrameBlock) == 576, "Frame std140 size");
static_assert(offsetof(SkyBlock, counts) == 144 && offsetof(SkyBlock, lamps) == 224,
              "Sky std140 offsets");
static_assert(offsetof(SkyBlock, screens) == 992 && sizeof(SkyBlock) == 1760, "Sky std140 size");

} // namespace office::scene
