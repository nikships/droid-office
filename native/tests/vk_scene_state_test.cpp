// The Vulkan scene renderer's pure tables (vk_scene_state.h): GL enum values to Vulkan values, the
// draw state the GLES renderer sets for a material, the pass winding rules and the pipeline key.
// The Vulkan values are literals from vulkan_core.h here; vk_scene_renderer.cpp static_asserts
// them against the header itself.
#include "vk_scene_state.h"

#include <cassert>
#include <iostream>
#include <set>
#include <tuple>

using namespace office;
using namespace office::scene;
using namespace office::vkscene;

namespace {

void compare() {
    // GL_NEVER .. GL_ALWAYS in order: VK_COMPARE_OP_NEVER 0 .. VK_COMPARE_OP_ALWAYS 7.
    const uint32_t gl[] = {0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207};
    for (uint32_t i = 0; i < 8; ++i)
        assert(compareOp(gl[i]) == i);
    assert(compareOp(0x0203) == 3); // GL_LEQUAL -> VK_COMPARE_OP_LESS_OR_EQUAL
    assert(compareOp(0) == vkv::kCompareLessOrEqual && compareOp(0x0208) == 3);
}

void blendFactors() {
    const std::tuple<uint32_t, uint32_t> rows[] = {
        {0x0000, 0},  {0x0001, 1},  {0x0300, 2},  {0x0301, 3},  {0x0306, 4},
        {0x0307, 5},  {0x0302, 6},  {0x0303, 7},  {0x0304, 8},  {0x0305, 9},
        {0x8001, 10}, {0x8002, 11}, {0x8003, 12}, {0x8004, 13}, {0x0308, 14},
    };
    std::set<uint32_t> seen;
    for (const auto &[glValue, vkValue] : rows) {
        assert(blendFactor(glValue) == vkValue);
        seen.insert(vkValue);
    }
    assert(seen.size() == 15); // every VkBlendFactor once
    assert(blendFactor(0x1234) == vkv::kOne);
    // GL_FUNC_ADD, SUBTRACT, REVERSE_SUBTRACT, MIN, MAX.
    assert(blendOp(0x8006) == 0 && blendOp(0x800A) == 1 && blendOp(0x800B) == 2 &&
           blendOp(0x8007) == 3 && blendOp(0x8008) == 4 && blendOp(0) == 0);
}

void samplers() {
    // GL_REPEAT, GL_MIRRORED_REPEAT, GL_CLAMP_TO_EDGE.
    assert(addressMode(0x2901) == 0 && addressMode(0x8370) == 1 && addressMode(0x812F) == 2);
    // Without mips: the base level with NEAREST or LINEAR, as GLES applySampler.
    for (uint32_t min : {0x2600u, 0x2700u, 0x2702u})
        assert(samplerSetup(0x2901, 0x2901, 0x2601, min, false, 1, 16).min == vkv::kNearest);
    for (uint32_t min : {0x2601u, 0x2701u, 0x2703u}) {
        const auto s = samplerSetup(0x2901, 0x2901, 0x2601, min, false, 1, 16);
        assert(s.min == vkv::kLinear && s.mipmap == 0);
    }
    // With mips: the mipmap mode the filter names; GL_NEAREST/GL_LINEAR keep the base level.
    assert(samplerSetup(0, 0, 0x2601, 0x2700, true, 1, 1).mipmap == 1 + vkv::kNearest);
    assert(samplerSetup(0, 0, 0x2601, 0x2701, true, 1, 1).mipmap == 1 + vkv::kNearest);
    assert(samplerSetup(0, 0, 0x2601, 0x2702, true, 1, 1).mipmap == 1 + vkv::kLinear);
    assert(samplerSetup(0, 0, 0x2601, 0x2703, true, 1, 1).mipmap == 1 + vkv::kLinear);
    assert(samplerSetup(0, 0, 0x2601, 0x2601, true, 1, 1).mipmap == 0);
    assert(samplerSetup(0, 0, 0x2600, 0x2601, true, 1, 1).mag == vkv::kNearest);
    // Anisotropy: clamped to the device, off without the feature or below 2.
    assert(samplerSetup(0, 0, 0x2601, 0x2703, true, 8, 16).anisotropy == 8);
    assert(samplerSetup(0, 0, 0x2601, 0x2703, true, 32, 16).anisotropy == 16);
    assert(samplerSetup(0, 0, 0x2601, 0x2703, true, 8, 1).anisotropy == 1);
    assert(samplerSetup(0, 0, 0x2601, 0x2703, true, 1, 16).anisotropy == 1);
}

MaterialState material(BlendMode mode, bool premultiplied, bool transparent) {
    MaterialState m;
    m.blend.mode = mode;
    m.blend.premultiplied = premultiplied;
    m.transparent = transparent;
    return m;
}

void blends() {
    // Normal blending only for transparent materials; None never.
    assert(!blendSetup(material(BlendMode::Normal, false, false)).enable);
    assert(!blendSetup(material(BlendMode::None, false, true)).enable);
    auto normal = blendSetup(material(BlendMode::Normal, false, true));
    assert(normal.enable && normal.srcColor == vkv::kSrcAlpha &&
           normal.dstColor == vkv::kOneMinusSrcAlpha && normal.srcAlpha == vkv::kOne &&
           normal.dstAlpha == vkv::kOneMinusSrcAlpha && normal.colorOp == vkv::kOpAdd);
    auto premultiplied = blendSetup(material(BlendMode::Normal, true, true));
    assert(premultiplied.srcColor == vkv::kOne && premultiplied.srcAlpha == vkv::kOne &&
           premultiplied.dstColor == vkv::kOneMinusSrcAlpha);
    // Additive, subtractive and multiply blend whatever the transparent flag says.
    auto additive = blendSetup(material(BlendMode::Additive, false, false));
    assert(additive.enable && additive.srcColor == vkv::kSrcAlpha &&
           additive.dstColor == vkv::kOne && additive.srcAlpha == vkv::kSrcAlpha &&
           additive.dstAlpha == vkv::kOne);
    auto additivePre = blendSetup(material(BlendMode::Additive, true, true));
    assert(additivePre.srcColor == vkv::kOne && additivePre.dstAlpha == vkv::kOne);
    auto subtractive = blendSetup(material(BlendMode::Subtractive, false, true));
    assert(subtractive.srcColor == vkv::kZero && subtractive.dstColor == vkv::kOneMinusSrcColor &&
           subtractive.srcAlpha == vkv::kZero && subtractive.dstAlpha == vkv::kOneMinusSrcColor);
    auto subtractivePre = blendSetup(material(BlendMode::Subtractive, true, true));
    assert(subtractivePre.dstColor == vkv::kOneMinusSrcColor &&
           subtractivePre.srcAlpha == vkv::kZero && subtractivePre.dstAlpha == vkv::kOne);
    auto multiply = blendSetup(material(BlendMode::Multiply, false, true));
    assert(multiply.srcColor == vkv::kZero && multiply.dstColor == vkv::kSrcColor &&
           multiply.dstAlpha == vkv::kSrcColor);
    auto multiplyPre = blendSetup(material(BlendMode::Multiply, true, true));
    assert(multiplyPre.dstColor == vkv::kSrcColor && multiplyPre.dstAlpha == vkv::kSrcAlpha);
    // Custom: the equation and the four factors as given.
    MaterialState custom = material(BlendMode::Custom, false, true);
    custom.blend.eq = 0x800B;
    custom.blend.eqAlpha = 0x8008;
    custom.blend.src = 0x0306;
    custom.blend.dst = 0x0001;
    custom.blend.srcAlpha = 0x0304;
    custom.blend.dstAlpha = 0x0000;
    auto c = blendSetup(custom);
    assert(c.enable && c.colorOp == vkv::kOpReverseSubtract && c.alphaOp == vkv::kOpMax &&
           c.srcColor == vkv::kDstColor && c.dstColor == vkv::kOne &&
           c.srcAlpha == vkv::kDstAlpha && c.dstAlpha == vkv::kZero);
}

void winding() {
    // A swapchain pass keeps GL's rule; the shadow pass (positive viewport) inverts it.
    assert(!frontClockwise(CullSide::Front, false, false));
    assert(frontClockwise(CullSide::Back, false, false));
    assert(frontClockwise(CullSide::Front, true, false));
    assert(!frontClockwise(CullSide::Back, true, false));
    assert(frontClockwise(CullSide::Front, false, true));
    assert(!frontClockwise(CullSide::Back, false, true));
    assert(!frontClockwise(CullSide::Double, true, true));
}

DrawItem triangles() {
    DrawItem it;
    auto v = std::make_shared<GpuVertices>();
    v->normal = v->uv = true;
    it.vertices = v;
    it.material = std::make_shared<MaterialState>();
    return it;
}

void drawState() {
    DrawItem it = triangles();
    assert(topology(it) == vkv::kTriangleList);
    auto layout = vertexLayout(it);
    assert(layout.normal && layout.uv && !layout.color && !layout.instances && !layout.pointQuads);
    it.useVertexColor = true;
    it.instances = std::make_shared<GpuInstances>();
    layout = vertexLayout(it);
    assert(layout.color && layout.instances);
    // Points without indices are quads, reading only position and color (per instance).
    it.mode = DrawMode::Points;
    layout = vertexLayout(it);
    assert(pointQuads(it) && topology(it) == vkv::kTriangleStrip && layout.pointQuads &&
           layout.color && !layout.normal && !layout.uv && !layout.instances);
    it.indices = std::make_shared<GpuIndices>();
    assert(!pointQuads(it) && topology(it) == vkv::kPointList);
    it.mode = DrawMode::Lines;
    assert(topology(it) == vkv::kLineList);
    it.mode = DrawMode::LineStrip;
    assert(topology(it) == vkv::kLineStrip);
    it.mode = DrawMode::LineLoop;
    assert(topology(it) == vkv::kLineStrip);

    // The world state follows the material and side; the shadow state is depth only.
    DrawItem world = triangles();
    auto m = std::make_shared<MaterialState>();
    m->depthWrite = false;
    m->depthFunc = 0x0201; // GL_LESS
    m->colorWrite = false;
    m->polygonOffset = true;
    m->shadowSide = CullSide::Double;
    world.material = m;
    world.side = CullSide::Back;
    auto s = worldState(world);
    assert(s.pass == PassClass::World && s.cull && s.frontClockwise && s.depthTest &&
           !s.depthWrite && s.compare == vkv::kCompareLess && !s.colorWrite && s.depthBias);
    auto shadow = shadowState(world);
    assert(shadow.pass == PassClass::Shadow && !shadow.cull && shadow.depthWrite &&
           shadow.compare == vkv::kCompareLessOrEqual && !shadow.colorWrite && !shadow.depthBias);
    world.side = CullSide::Double;
    assert(!worldState(world).cull);

    // castsShadow: casting triangles, not sprites, not the back half of a two-pass draw.
    DrawItem caster = triangles();
    assert(!castsShadow(caster));
    caster.castShadow = true;
    assert(castsShadow(caster));
    caster.mode = DrawMode::Lines;
    assert(!castsShadow(caster));
    caster.mode = DrawMode::Triangles;
    caster.key.model = ShadeModel::Sprite;
    assert(!castsShadow(caster));
    caster.key.model = ShadeModel::Toon;
    auto twoPass = std::make_shared<MaterialState>();
    twoPass->side = CullSide::Double;
    caster.material = twoPass;
    caster.side = CullSide::Back;
    assert(!castsShadow(caster));
}

void keys() {
    // Every field of the state changes the key; equal states give equal keys.
    DrawItem it = triangles();
    const PipelineState base = worldState(it);
    std::set<std::tuple<uint32_t, uint32_t, uint32_t>> seen;
    auto add = [&](const PipelineState &s, uint32_t program) {
        const PipelineKey k = packKey(program, s);
        return seen.insert({k.program, k.state, k.blend}).second;
    };
    assert(add(base, 1));
    assert(!add(base, 1));
    assert(add(base, 2));
    PipelineState s = base;
    s.pass = PassClass::Shadow;
    assert(add(s, 1));
    s = base;
    s.topology = vkv::kLineStrip;
    assert(add(s, 1));
    bool PipelineState::*flags[] = {&PipelineState::cull,       &PipelineState::frontClockwise,
                                    &PipelineState::depthTest,  &PipelineState::depthWrite,
                                    &PipelineState::colorWrite, &PipelineState::depthBias};
    for (auto flag : flags) {
        s = base;
        s.*flag = !(s.*flag);
        assert(add(s, 1));
    }
    bool VertexLayout::*arrays[] = {&VertexLayout::normal, &VertexLayout::uv, &VertexLayout::color,
                                    &VertexLayout::instances, &VertexLayout::pointQuads};
    for (auto array : arrays) {
        s = base;
        s.vertex.*array = !(s.vertex.*array);
        assert(add(s, 1));
    }
    s = base;
    s.compare = vkv::kCompareGreater;
    assert(add(s, 1));
    // Blending: every factor and op, and only an enabled blend counts.
    s = base;
    s.blend.srcColor = vkv::kSrcAlpha;
    assert(!add(s, 1)); // disabled: the factors do not matter
    s.blend.enable = true;
    assert(add(s, 1));
    uint32_t BlendSetup::*fields[] = {&BlendSetup::srcColor, &BlendSetup::dstColor,
                                      &BlendSetup::colorOp,  &BlendSetup::srcAlpha,
                                      &BlendSetup::dstAlpha, &BlendSetup::alphaOp};
    for (auto field : fields) {
        PipelineState b = s;
        b.blend.*field = (b.blend.*field + 1) % 5;
        assert(add(b, 1));
    }
    assert(PipelineKeyHash{}(packKey(1, base)) == PipelineKeyHash{}(packKey(1, base)));
    assert(alignUp(0, 256) == 0 && alignUp(1, 256) == 256 && alignUp(528, 64) == 576);
}

} // namespace

int main() {
    compare();
    blendFactors();
    samplers();
    blends();
    winding();
    drawState();
    keys();
    std::cout << "vk_scene_state tests passed\n";
}
