// The Vulkan scene renderer's pure tables (research/vulkan-port.md 4.5): the GL enum values the
// scene model carries (scene_model.h BlendState, MaterialState, TextureOp) as the numeric values of
// the Vulkan enums they become, the draw state of a material as the GLES renderer sets it
// (scene_renderer.cpp setBlend, setFaces, setDepth), and the pipeline key. GL- and Vulkan-free,
// so the host tests check every row; vk_scene_renderer.cpp static_asserts that each Vulkan value
// is the one its header defines.
#pragma once

#include "scene_model.h"

#include <cstddef>
#include <cstdint>
#include <functional>

namespace office::vkscene {

// ---- Numeric Vulkan enum values (vulkan_core.h) -------------------------------------------------
namespace vkv {
// VkCompareOp
constexpr uint32_t kCompareNever = 0, kCompareLess = 1, kCompareEqual = 2,
                   kCompareLessOrEqual = 3, kCompareGreater = 4, kCompareNotEqual = 5,
                   kCompareGreaterOrEqual = 6, kCompareAlways = 7;
// VkBlendFactor
constexpr uint32_t kZero = 0, kOne = 1, kSrcColor = 2, kOneMinusSrcColor = 3, kDstColor = 4,
                   kOneMinusDstColor = 5, kSrcAlpha = 6, kOneMinusSrcAlpha = 7, kDstAlpha = 8,
                   kOneMinusDstAlpha = 9, kConstantColor = 10, kOneMinusConstantColor = 11,
                   kConstantAlpha = 12, kOneMinusConstantAlpha = 13, kSrcAlphaSaturate = 14;
// VkBlendOp
constexpr uint32_t kOpAdd = 0, kOpSubtract = 1, kOpReverseSubtract = 2, kOpMin = 3, kOpMax = 4;
// VkSamplerAddressMode
constexpr uint32_t kRepeat = 0, kMirroredRepeat = 1, kClampToEdge = 2;
// VkFilter, VkSamplerMipmapMode
constexpr uint32_t kNearest = 0, kLinear = 1;
// VkPrimitiveTopology
constexpr uint32_t kPointList = 0, kLineList = 1, kLineStrip = 2, kTriangleList = 3,
                   kTriangleStrip = 4;
} // namespace vkv

// ---- GL -> Vulkan ------------------------------------------------------------------------------

/** glDepthFunc values (GL_NEVER 0x0200 .. GL_ALWAYS 0x0207) map in order; others are LEQUAL. */
inline uint32_t compareOp(uint32_t gl) {
    return gl >= 0x0200 && gl <= 0x0207 ? gl - 0x0200 : vkv::kCompareLessOrEqual;
}

/** glBlendFunc factors; an unknown value is ONE, a visible rather than a missing draw. */
inline uint32_t blendFactor(uint32_t gl) {
    switch (gl) {
    case 0x0000: // GL_ZERO
        return vkv::kZero;
    case 0x0001: // GL_ONE
        return vkv::kOne;
    case 0x0300: // GL_SRC_COLOR
        return vkv::kSrcColor;
    case 0x0301: // GL_ONE_MINUS_SRC_COLOR
        return vkv::kOneMinusSrcColor;
    case 0x0302: // GL_SRC_ALPHA
        return vkv::kSrcAlpha;
    case 0x0303: // GL_ONE_MINUS_SRC_ALPHA
        return vkv::kOneMinusSrcAlpha;
    case 0x0304: // GL_DST_ALPHA
        return vkv::kDstAlpha;
    case 0x0305: // GL_ONE_MINUS_DST_ALPHA
        return vkv::kOneMinusDstAlpha;
    case 0x0306: // GL_DST_COLOR
        return vkv::kDstColor;
    case 0x0307: // GL_ONE_MINUS_DST_COLOR
        return vkv::kOneMinusDstColor;
    case 0x0308: // GL_SRC_ALPHA_SATURATE
        return vkv::kSrcAlphaSaturate;
    case 0x8001: // GL_CONSTANT_COLOR
        return vkv::kConstantColor;
    case 0x8002: // GL_ONE_MINUS_CONSTANT_COLOR
        return vkv::kOneMinusConstantColor;
    case 0x8003: // GL_CONSTANT_ALPHA
        return vkv::kConstantAlpha;
    case 0x8004: // GL_ONE_MINUS_CONSTANT_ALPHA
        return vkv::kOneMinusConstantAlpha;
    default:
        return vkv::kOne;
    }
}

/** glBlendEquation modes; an unknown value is ADD. */
inline uint32_t blendOp(uint32_t gl) {
    switch (gl) {
    case 0x800A: // GL_FUNC_SUBTRACT
        return vkv::kOpSubtract;
    case 0x800B: // GL_FUNC_REVERSE_SUBTRACT
        return vkv::kOpReverseSubtract;
    case 0x8007: // GL_MIN
        return vkv::kOpMin;
    case 0x8008: // GL_MAX
        return vkv::kOpMax;
    default: // GL_FUNC_ADD 0x8006
        return vkv::kOpAdd;
    }
}

/** GL_TEXTURE_WRAP_* values; an unknown value clamps, as GL_CLAMP_TO_EDGE (0x812F). */
inline uint32_t addressMode(uint32_t gl) {
    switch (gl) {
    case 0x2901: // GL_REPEAT
        return vkv::kRepeat;
    case 0x8370: // GL_MIRRORED_REPEAT
        return vkv::kMirroredRepeat;
    default:
        return vkv::kClampToEdge;
    }
}

/**
 * A GL sampler as Vulkan filters. The minification filter's mipmap part only applies with mips;
 * without them GLES (applySampler) samples level 0 with the NEAREST or LINEAR the filter starts
 * with, which maxLod 0 reproduces. mipmap: 0 base level only, else 1 + VkSamplerMipmapMode.
 */
struct SamplerSetup {
    uint32_t mag = vkv::kLinear, min = vkv::kLinear;
    uint32_t mipmap = 0;
    uint32_t wrapS = vkv::kClampToEdge, wrapT = vkv::kClampToEdge;
    float anisotropy = 1; // 1: off
    bool operator==(const SamplerSetup &o) const {
        return mag == o.mag && min == o.min && mipmap == o.mipmap && wrapS == o.wrapS &&
               wrapT == o.wrapT && anisotropy == o.anisotropy;
    }
};

/**
 * `maxAnisotropy` is the device limit when samplerAnisotropy is enabled, else 1; GLES clamps the
 * material's anisotropy to GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT the same way.
 */
inline SamplerSetup samplerSetup(uint32_t wrapS, uint32_t wrapT, uint32_t mag, uint32_t min,
                                 bool mips, float aniso, float maxAnisotropy) {
    SamplerSetup s;
    s.wrapS = addressMode(wrapS);
    s.wrapT = addressMode(wrapT);
    s.mag = mag == 0x2600 ? vkv::kNearest : vkv::kLinear; // GL_NEAREST
    // GL_NEAREST 0x2600, GL_NEAREST_MIPMAP_NEAREST 0x2700 and GL_NEAREST_MIPMAP_LINEAR 0x2702
    // filter the level with NEAREST; GL_LINEAR 0x2601 and the other two with LINEAR.
    s.min = min == 0x2600 || min == 0x2700 || min == 0x2702 ? vkv::kNearest : vkv::kLinear;
    if (mips && (min == 0x2700 || min == 0x2701))
        s.mipmap = 1 + vkv::kNearest;
    else if (mips && (min == 0x2702 || min == 0x2703))
        s.mipmap = 1 + vkv::kLinear;
    if (maxAnisotropy > 1 && aniso > 1)
        s.anisotropy = aniso < maxAnisotropy ? aniso : maxAnisotropy;
    return s;
}

/** A color attachment's blend state. Factors and ops are Vulkan values. */
struct BlendSetup {
    bool enable = false;
    uint32_t srcColor = vkv::kOne, dstColor = vkv::kZero, colorOp = vkv::kOpAdd;
    uint32_t srcAlpha = vkv::kOne, dstAlpha = vkv::kZero, alphaOp = vkv::kOpAdd;
};

/** three's WebGLState.setBlending as the GLES renderer applies it (setBlend). */
inline BlendSetup blendSetup(const scene::MaterialState &m) {
    using scene::BlendMode;
    const scene::BlendState &b = m.blend;
    BlendSetup s;
    if (b.mode == BlendMode::None || (b.mode == BlendMode::Normal && !m.transparent))
        return s;
    s.enable = true;
    auto both = [&s](uint32_t src, uint32_t dst) {
        s.srcColor = s.srcAlpha = src;
        s.dstColor = s.dstAlpha = dst;
    };
    if (b.mode == BlendMode::Custom) {
        s.colorOp = blendOp(b.eq);
        s.alphaOp = blendOp(b.eqAlpha);
        s.srcColor = blendFactor(b.src);
        s.dstColor = blendFactor(b.dst);
        s.srcAlpha = blendFactor(b.srcAlpha);
        s.dstAlpha = blendFactor(b.dstAlpha);
        return s;
    }
    if (b.premultiplied) {
        switch (b.mode) {
        case BlendMode::Additive:
            both(vkv::kOne, vkv::kOne);
            break;
        case BlendMode::Subtractive:
            s.srcColor = vkv::kZero;
            s.dstColor = vkv::kOneMinusSrcColor;
            s.srcAlpha = vkv::kZero;
            s.dstAlpha = vkv::kOne;
            break;
        case BlendMode::Multiply:
            s.srcColor = vkv::kZero;
            s.dstColor = vkv::kSrcColor;
            s.srcAlpha = vkv::kZero;
            s.dstAlpha = vkv::kSrcAlpha;
            break;
        default:
            both(vkv::kOne, vkv::kOneMinusSrcAlpha);
            break;
        }
    } else {
        switch (b.mode) {
        case BlendMode::Additive:
            both(vkv::kSrcAlpha, vkv::kOne);
            break;
        case BlendMode::Subtractive:
            both(vkv::kZero, vkv::kOneMinusSrcColor);
            break;
        case BlendMode::Multiply:
            both(vkv::kZero, vkv::kSrcColor);
            break;
        default:
            s.srcColor = vkv::kSrcAlpha;
            s.dstColor = vkv::kOneMinusSrcAlpha;
            s.srcAlpha = vkv::kOne;
            s.dstAlpha = vkv::kOneMinusSrcAlpha;
            break;
        }
    }
    return s;
}

/**
 * Whether front faces wind clockwise in the pass: three's setMaterial (BackSide xor a mirrored
 * matrix), as the GLES renderer's setFaces. A swapchain pass draws with a negative viewport
 * height, which keeps GL's winding as Vulkan computes it; the shadow pass has a positive one, so
 * the same window coordinates give the opposite sign and its rule is inverted
 * (research/vulkan-port.md 4.3).
 */
inline bool frontClockwise(scene::CullSide side, bool mirrored, bool shadowPass) {
    const bool cw = (side == scene::CullSide::Back) != mirrored;
    return shadowPass ? !cw : cw;
}

/** The pass a pipeline is made for. */
enum class PassClass : uint8_t { World = 0, Shadow = 1 };

/** The vertex arrays a draw reads (the GLES renderer's vertex array enables). */
struct VertexLayout {
    bool normal = false, uv = false, color = false, instances = false;
    bool pointQuads = false; // points as instanced quads: binding 0 advances per instance
};

/** Points drawn as quads (the GLES renderer's pointQuads): non-indexed points. */
inline bool pointQuads(const scene::DrawItem &it) {
    return it.mode == scene::DrawMode::Points && !it.indices;
}

inline VertexLayout vertexLayout(const scene::DrawItem &it) {
    VertexLayout v;
    v.pointQuads = pointQuads(it);
    v.color = it.useVertexColor;
    if (!v.pointQuads) {
        v.normal = it.vertices && it.vertices->normal;
        v.uv = it.vertices && it.vertices->uv;
        v.instances = it.instances != nullptr;
    }
    return v;
}

/** The draw's VkPrimitiveTopology: a line loop is a strip closed by a second two-index draw. */
inline uint32_t topology(const scene::DrawItem &it) {
    if (pointQuads(it))
        return vkv::kTriangleStrip;
    switch (it.mode) {
    case scene::DrawMode::Lines:
        return vkv::kLineList;
    case scene::DrawMode::LineStrip:
    case scene::DrawMode::LineLoop:
        return vkv::kLineStrip;
    case scene::DrawMode::Points:
        return vkv::kPointList;
    default:
        return vkv::kTriangleList;
    }
}

/**
 * Everything a graphics pipeline is created from besides the render pass: the program and the
 * fixed-function state of one draw. Depth bias values, viewport and scissor are dynamic.
 */
struct PipelineKey {
    uint32_t program = 0; // scene::ProgramKey::bits()
    uint32_t state = 0;   // packed below
    uint32_t blend = 0;   // packed BlendSetup

    bool operator==(const PipelineKey &o) const {
        return program == o.program && state == o.state && blend == o.blend;
    }
};

struct PipelineState {
    PassClass pass = PassClass::World;
    uint32_t topology = vkv::kTriangleList;
    VertexLayout vertex;
    bool cull = false, frontClockwise = false;
    bool depthTest = true, depthWrite = true;
    uint32_t compare = vkv::kCompareLessOrEqual;
    bool colorWrite = true, depthBias = false;
    BlendSetup blend;
};

inline PipelineKey packKey(uint32_t programBits, const PipelineState &s) {
    PipelineKey k;
    k.program = programBits;
    uint32_t v = uint32_t(s.pass) & 3u;
    v |= (s.topology & 7u) << 2;
    v |= uint32_t(s.vertex.normal) << 5 | uint32_t(s.vertex.uv) << 6 |
         uint32_t(s.vertex.color) << 7 | uint32_t(s.vertex.instances) << 8 |
         uint32_t(s.vertex.pointQuads) << 9;
    v |= uint32_t(s.cull) << 10 | uint32_t(s.frontClockwise) << 11 |
         uint32_t(s.depthTest) << 12 | uint32_t(s.depthWrite) << 13;
    v |= (s.compare & 7u) << 14;
    v |= uint32_t(s.colorWrite) << 17 | uint32_t(s.depthBias) << 18;
    k.state = v;
    const BlendSetup &b = s.blend;
    if (b.enable)
        k.blend = 1u | (b.srcColor & 15u) << 1 | (b.dstColor & 15u) << 5 | (b.colorOp & 7u) << 9 |
                  (b.srcAlpha & 15u) << 12 | (b.dstAlpha & 15u) << 16 | (b.alphaOp & 7u) << 20;
    return k;
}

/** The world pass's state for a draw: the material's blend, faces, depth and color writes. */
inline PipelineState worldState(const scene::DrawItem &it) {
    const scene::MaterialState &m = *it.material;
    PipelineState s;
    s.pass = PassClass::World;
    s.topology = topology(it);
    s.vertex = vertexLayout(it);
    s.cull = it.side != scene::CullSide::Double;
    s.frontClockwise = frontClockwise(it.side, it.mirrored, false);
    s.depthTest = m.depthTest;
    s.depthWrite = m.depthWrite;
    s.compare = compareOp(m.depthFunc);
    s.colorWrite = m.colorWrite;
    s.depthBias = m.polygonOffset;
    s.blend = blendSetup(m);
    return s;
}

/** The shadow pass's state (renderShadow): depth only, LEQUAL with writes, the shadow side. */
inline PipelineState shadowState(const scene::DrawItem &it) {
    PipelineState s;
    s.pass = PassClass::Shadow;
    s.topology = topology(it);
    s.vertex = vertexLayout(it);
    s.cull = it.material->shadowSide != scene::CullSide::Double;
    s.frontClockwise = frontClockwise(it.material->shadowSide, it.mirrored, true);
    s.depthTest = s.depthWrite = true;
    s.compare = vkv::kCompareLessOrEqual;
    s.colorWrite = false;
    return s;
}

/** Whether the shadow pass draws `it` (the GLES renderer's castsShadow). */
inline bool castsShadow(const scene::DrawItem &it) {
    if (!it.castShadow || it.mode != scene::DrawMode::Triangles ||
        it.key.model == scene::ShadeModel::Sprite)
        return false;
    // The back-face half of a two-pass transparent draw.
    return !(it.side == scene::CullSide::Back && it.material->side == scene::CullSide::Double);
}

struct PipelineKeyHash {
    size_t operator()(const PipelineKey &k) const {
        uint64_t h = scene::mix64(scene::mix64(k.program, k.state), k.blend);
        return size_t(h);
    }
};

/** Bytes from `offset` rounded up to `alignment` (a power of two or any positive value). */
inline uint64_t alignUp(uint64_t offset, uint64_t alignment) {
    return alignment ? (offset + alignment - 1) / alignment * alignment : offset;
}

} // namespace office::vkscene
