// Writes the GLSL for every meaningful ProgramKey into a directory (name.vert, name.frag) for
// glslangValidator, and checks what can be checked without a GL context: the keys' bits() are
// unique, generation is deterministic, the std140 blocks match scene_uniforms.h member for member,
// and the stages keep the contract (attribute locations, no gl_ViewID_OVR in fragment shaders).
//
//   dump <out-dir>     exit status 0 when every check passes
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <regex>
#include <set>
#include <string>
#include <vector>

#include "scene_shaders.h"
#include "scene_uniforms.h"

using namespace office::scene;

namespace {

int failures = 0;

void fail(const std::string &what) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++failures;
}

// The std140 layout of one member list, computed the way GLSL does, to compare against the structs.
struct Member {
    std::string type, name;
    int count; // 1 when not an array
};

std::vector<Member> parseBlock(const std::string &src, const std::string &block) {
    std::vector<Member> out;
    const std::string head = "uniform " + block + " {";
    const size_t at = src.find(head);
    if (at == std::string::npos)
        return out;
    const size_t end = src.find('}', at);
    const std::string body = src.substr(at + head.size(), end - at - head.size());
    static const std::regex member(
        R"(\s*(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)(?:\[(\w+)\])?\s*;)");
    for (auto it = std::sregex_iterator(body.begin(), body.end(), member);
         it != std::sregex_iterator(); ++it) {
        const std::smatch &m = *it;
        out.push_back({m[1], m[2], m[3].matched ? std::stoi(m[3]) : 1});
    }
    return out;
}

// Byte size of a std140 block made of vec4 / ivec4 / mat4 members (all 16-byte aligned).
size_t std140Size(const std::vector<Member> &ms, std::map<std::string, size_t> *offsets) {
    size_t off = 0;
    for (const Member &m : ms) {
        size_t each = 0;
        if (m.type == "vec4" || m.type == "ivec4")
            each = 16;
        else if (m.type == "mat4")
            each = 64;
        else
            fail("std140 member type " + m.type + " " + m.name + " is not vec4/ivec4/mat4");
        if (offsets)
            (*offsets)[m.name] = off;
        off += each * size_t(m.count);
    }
    return off;
}

// The member lists the structs in scene_uniforms.h declare, in order.
const std::vector<Member> &expectedBlock(const std::string &name) {
    static const std::vector<Member> view = {
        {"mat4", "viewProj", 2},  {"mat4", "view", 2},     {"mat4", "proj", 2},
        {"vec4", "cameraPos", 2}, {"vec4", "viewport", 1},
    };
    static const std::vector<Member> frame = {
        {"vec4", "fogColor", 1},
        {"vec4", "fogParams", 1},
        {"vec4", "ambient", 1},
        {"ivec4", "counts", 1},
        {"vec4", "hemiSky", kMaxHemi},
        {"vec4", "hemiGround", kMaxHemi},
        {"vec4", "hemiDir", kMaxHemi},
        {"vec4", "dirColor", kMaxDir},
        {"vec4", "dirDir", kMaxDir},
        {"vec4", "pointPos", kMaxPoint},
        {"vec4", "pointColor", kMaxPoint},
        {"mat4", "shadowMatrix", 1},
        {"vec4", "shadowParams", 1},
        {"vec4", "shadowMapSize", 1},
    };
    static const std::vector<Member> sky = {
        {"vec4", "flags", 1},
        {"vec4", "misc", 1},
        {"vec4", "haze", 1},
        {"vec4", "office", 1},
        {"vec4", "garage", 1},
        {"vec4", "officeMin", 1},
        {"vec4", "officeMax", 1},
        {"vec4", "garageBox", 1},
        {"vec4", "garageY", 1},
        {"ivec4", "counts", 1},
        {"vec4", "lampMin", 1},
        {"vec4", "lampMax", 1},
        {"vec4", "screenMin", 1},
        {"vec4", "screenMax", 1},
        {"vec4", "lamps", kMaxLamps},
        {"vec4", "lampColors", kMaxLamps},
        {"vec4", "screens", kMaxScreens},
        {"vec4", "screenDirs", kMaxScreens},
        {"vec4", "screenColors", kMaxScreens},
    };
    if (name == "View")
        return view;
    if (name == "Frame")
        return frame;
    return sky;
}

// Offsets of the structs, from the compiler, for the members the static_asserts do not cover.
const std::map<std::string, std::map<std::string, size_t>> &structOffsets() {
#define O(S, m)                                                                                    \
    { #m, offsetof(S, m) }
    static const std::map<std::string, std::map<std::string, size_t>> o = {
        {"View",
         {O(ViewBlock, viewProj), O(ViewBlock, view), O(ViewBlock, proj), O(ViewBlock, cameraPos),
          O(ViewBlock, viewport)}},
        {"Frame",
         {O(FrameBlock, fogColor), O(FrameBlock, fogParams), O(FrameBlock, ambient),
          O(FrameBlock, counts), O(FrameBlock, hemiSky), O(FrameBlock, hemiGround),
          O(FrameBlock, hemiDir), O(FrameBlock, dirColor), O(FrameBlock, dirDir),
          O(FrameBlock, pointPos), O(FrameBlock, pointColor), O(FrameBlock, shadowMatrix),
          O(FrameBlock, shadowParams), O(FrameBlock, shadowMapSize)}},
        {"Sky",
         {O(SkyBlock, flags), O(SkyBlock, misc), O(SkyBlock, haze), O(SkyBlock, office),
          O(SkyBlock, garage), O(SkyBlock, officeMin), O(SkyBlock, officeMax),
          O(SkyBlock, garageBox), O(SkyBlock, garageY), O(SkyBlock, counts), O(SkyBlock, lampMin),
          O(SkyBlock, lampMax), O(SkyBlock, screenMin), O(SkyBlock, screenMax), O(SkyBlock, lamps),
          O(SkyBlock, lampColors), O(SkyBlock, screens), O(SkyBlock, screenDirs),
          O(SkyBlock, screenColors)}},
    };
#undef O
    return o;
}

size_t structSize(const std::string &name) {
    if (name == "View")
        return sizeof(ViewBlock);
    if (name == "Frame")
        return sizeof(FrameBlock);
    return sizeof(SkyBlock);
}

void checkBlocks(const std::string &prog, const std::string &stage, const std::string &src) {
    for (const char *name : {"View", "Frame", "Sky"}) {
        const std::vector<Member> got = parseBlock(src, name);
        if (got.empty())
            continue;
        const std::vector<Member> &want = expectedBlock(name);
        bool same = got.size() == want.size();
        for (size_t i = 0; same && i < got.size(); ++i)
            same = got[i].type == want[i].type && got[i].name == want[i].name &&
                   got[i].count == want[i].count;
        if (!same) {
            fail(prog + "." + stage + ": block " + name + " does not match scene_uniforms.h");
            continue;
        }
        std::map<std::string, size_t> offsets;
        const size_t size = std140Size(got, &offsets);
        if (size != structSize(name))
            fail(prog + "." + stage + ": block " + name + " std140 size " + std::to_string(size));
        for (const auto &[member, off] : structOffsets().at(name))
            if (offsets[member] != off)
                fail(prog + "." + stage + ": " + name + "." + member + " std140 offset " +
                     std::to_string(offsets[member]));
        if (src.find("layout(std140) uniform " + std::string(name) + " {") == std::string::npos)
            fail(prog + "." + stage + ": block " + name + " is not layout(std140)");
    }
}

void checkStages(const ProgramKey &k, const std::string &prog, const ShaderSource &s) {
    if (s.vertex.rfind("#version 300 es\n", 0) != 0 ||
        s.fragment.rfind("#version 300 es\n", 0) != 0)
        fail(prog + ": not #version 300 es first");
    const bool mv = k.multiview && k.model != ShadeModel::Depth;
    const bool hasExt =
        s.vertex.find("#extension GL_OVR_multiview2 : require\nlayout(num_views = 2) in;") !=
        std::string::npos;
    if (mv != hasExt)
        fail(prog + ": multiview header " + (mv ? "missing" : "unexpected"));
    if (s.fragment.find("gl_ViewID_OVR") != std::string::npos ||
        s.fragment.find("multiview") != std::string::npos)
        fail(prog + ": fragment shader uses multiview");
    if (!mv && s.vertex.find("gl_ViewID_OVR") != std::string::npos)
        fail(prog + ": single-view shader reads gl_ViewID_OVR");
    const struct {
        Attribute loc;
        const char *decl;
    } attrs[] = {{kAttrPosition, "vec3 aPosition"},
                 {kAttrNormal, "vec3 aNormal"},
                 {kAttrUv, "vec2 aUv"},
                 {kAttrColor, "vec4 aColor"},
                 {kAttrInstance0, "vec4 aInstance0"},
                 {kAttrInstance1, "vec4 aInstance1"},
                 {kAttrInstance2, "vec4 aInstance2"},
                 {kAttrInstanceColor, "vec3 aInstanceColor"}};
    for (const auto &a : attrs) {
        const std::string decl =
            "layout(location = " + std::to_string(a.loc) + ") in " + a.decl + ";\n";
        if (s.vertex.find(decl) == std::string::npos)
            fail(prog + ": missing " + decl);
    }
    if (s.fragment.find("precision highp float;") == std::string::npos ||
        s.fragment.find("precision highp sampler2DShadow;") == std::string::npos ||
        s.vertex.find("precision highp float;") == std::string::npos)
        fail(prog + ": precision");
    if (s.fragment.find("uShadowMap") != std::string::npos &&
        s.fragment.find("uniform highp sampler2DShadow uShadowMap;") == std::string::npos)
        fail(prog + ": uShadowMap is not highp sampler2DShadow");
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: dump <out-dir>\n");
        return 2;
    }
    const std::string dir = argv[1];

    const ShadeModel models[] = {ShadeModel::Basic,   ShadeModel::Toon,     ShadeModel::Lambert,
                                 ShadeModel::Phong,   ShadeModel::Standard, ShadeModel::Points,
                                 ShadeModel::Line,    ShadeModel::Sprite,   ShadeModel::Beam,
                                 ShadeModel::SkyDome, ShadeModel::Depth};

    std::vector<ProgramKey> keys;
    auto push = [&keys](ProgramKey k) { keys.push_back(k); };
    for (ShadeModel m : models) {
        for (int mv = 0; mv < 2; ++mv)
            for (int lin = 0; lin < 2; ++lin)
                for (FogMode fog : {FogMode::None, FogMode::Linear, FogMode::Exp2})
                    for (int sky = 0; sky < 2; ++sky) {
                        ProgramKey k;
                        k.model = m;
                        k.multiview = mv;
                        k.linearOutput = lin;
                        k.fog = fog;
                        k.sky = sky;
                        push(k);            // bare
                        ProgramKey all = k; // every flag at once
                        all.map = all.alphaMap = all.emissiveMap = all.gradientMap = all.alphaTest =
                            true;
                        all.premultipliedAlpha = all.doubleSided = all.shadows = true;
                        push(all);
                        ProgramKey flat = all;
                        flat.flatShading = true;
                        flat.backSide = true;
                        flat.doubleSided = false;
                        flat.opaque = true;
                        flat.sizeAttenuation = false;
                        push(flat);
                    }
        // Each flag alone, on the headset's usual base (multiview, linear output, haze).
        ProgramKey base;
        base.model = m;
        base.multiview = true;
        base.fog = FogMode::Linear;
        base.sky = true;
        bool ProgramKey::*flags[] = {&ProgramKey::map,
                                     &ProgramKey::alphaMap,
                                     &ProgramKey::emissiveMap,
                                     &ProgramKey::gradientMap,
                                     &ProgramKey::alphaTest,
                                     &ProgramKey::opaque,
                                     &ProgramKey::premultipliedAlpha,
                                     &ProgramKey::doubleSided,
                                     &ProgramKey::backSide,
                                     &ProgramKey::shadows,
                                     &ProgramKey::flatShading};
        for (auto flag : flags) {
            ProgramKey k = base;
            k.*flag = true;
            push(k);
            k.multiview = false;
            push(k);
        }
        ProgramKey fixed = base;
        fixed.sizeAttenuation = false;
        push(fixed);
        // The office's most common real keys.
        ProgramKey toon = base;
        toon.gradientMap = toon.shadows = toon.opaque = true;
        push(toon);
        toon.map = true;
        push(toon);
        ProgramKey text = base; // canvas text / boards: basic + map, transparent
        text.map = true;
        text.alphaTest = true;
        push(text);
        // The high-resolution screen layer: laptop screens and the overlays drawn over them, with
        // a 2D or array world depth, in both view modes and with every flag.
        for (SharpDepth depth : {SharpDepth::Texture2D, SharpDepth::Array})
            for (int overlay = 0; overlay < 2; ++overlay)
                for (int mv = 0; mv < 2; ++mv) {
                    ProgramKey k = base;
                    k.sharpDepth = depth;
                    k.sharpOverlay = overlay;
                    k.multiview = mv;
                    push(k);
                    ProgramKey screen = k; // the laptop screen's own key
                    screen.map = screen.opaque = true;
                    push(screen);
                    ProgramKey all = k;
                    all.map = all.alphaMap = all.emissiveMap = all.gradientMap = all.alphaTest =
                        true;
                    all.premultipliedAlpha = all.doubleSided = all.shadows = true;
                    all.linearOutput = false;
                    all.fog = FogMode::Exp2;
                    push(all);
                }
    }

    std::set<uint32_t> seenBits;
    std::map<uint32_t, std::string> nameOfBits;
    std::set<std::string> written;
    int programs = 0;
    for (const ProgramKey &k : keys) {
        const uint32_t b = k.bits();
        if (seenBits.count(b))
            continue;
        seenBits.insert(b);
        const ShaderSource s = generateShader(k);
        const ShaderSource again = generateShader(k);
        if (s.vertex != again.vertex || s.fragment != again.fragment)
            fail("nondeterministic " + programName(k));

        char hex[16];
        std::snprintf(hex, sizeof hex, "%06x", b);
        const std::string prog = programName(k) + "." + hex;
        checkStages(k, prog, s);
        checkBlocks(prog, "vert", s.vertex);
        checkBlocks(prog, "frag", s.fragment);
        std::ofstream(dir + "/" + prog + ".vert") << s.vertex;
        std::ofstream(dir + "/" + prog + ".frag") << s.fragment;
        written.insert(prog);
        ++programs;
    }

    // bits() tells apart keys that differ in any one field.
    ProgramKey a;
    std::set<uint32_t> one = {a.bits()};
    auto differs = [&](ProgramKey k, const char *what) {
        if (!one.insert(k.bits()).second)
            fail(std::string("bits() collision on ") + what);
    };
    for (int m = 1; m <= int(ShadeModel::Depth); ++m) {
        ProgramKey k;
        k.model = ShadeModel(m);
        differs(k, "model");
    }
    {
        ProgramKey k;
        k.fog = FogMode::Linear;
        differs(k, "fog linear");
        k.fog = FogMode::Exp2;
        differs(k, "fog exp2");
    }
    bool ProgramKey::*all[] = {&ProgramKey::multiview,
                               &ProgramKey::linearOutput,
                               &ProgramKey::sky,
                               &ProgramKey::map,
                               &ProgramKey::alphaMap,
                               &ProgramKey::emissiveMap,
                               &ProgramKey::gradientMap,
                               &ProgramKey::alphaTest,
                               &ProgramKey::opaque,
                               &ProgramKey::premultipliedAlpha,
                               &ProgramKey::doubleSided,
                               &ProgramKey::backSide,
                               &ProgramKey::shadows,
                               &ProgramKey::flatShading,
                               &ProgramKey::sizeAttenuation};
    for (auto flag : all) {
        ProgramKey k;
        k.*flag = !(k.*flag);
        differs(k, "flag");
    }
    {
        ProgramKey k;
        k.sharpDepth = SharpDepth::Texture2D;
        differs(k, "sharp 2d");
        k.sharpDepth = SharpDepth::Array;
        differs(k, "sharp array");
        k.sharpOverlay = true;
        differs(k, "sharp overlay");
    }
    // The screen layer's contract: only its variants sample the world depth, with the sampler
    // type of their depth texture, and screens never read the world depth of another view.
    for (const ProgramKey &k : keys) {
        const ShaderSource s = generateShader(k);
        const std::string prog = programName(k);
        const bool shaderMaterial = k.model == ShadeModel::Beam || k.model == ShadeModel::SkyDome ||
                                    k.model == ShadeModel::Depth;
        const SharpDepth want = shaderMaterial ? SharpDepth::None : k.sharpDepth;
        const bool has2d =
            s.fragment.find("uniform highp sampler2D uSharpDepth;") != std::string::npos;
        const bool hasArray =
            s.fragment.find("uniform highp sampler2DArray uSharpDepth;") != std::string::npos;
        if (has2d != (want == SharpDepth::Texture2D) || hasArray != (want == SharpDepth::Array))
            fail(prog + ": screen layer depth sampler does not match the key");
        if (want == SharpDepth::None && s.fragment.find("uSharp") != std::string::npos)
            fail(prog + ": world pass reads the screen layer uniforms");
        if (want != SharpDepth::None &&
            s.fragment.find("if ( sharpHidden ) discard;") == std::string::npos)
            fail(prog + ": screen layer never applies its depth test");
    }

    std::printf("programs %d (from %zu keys)\n", programs, keys.size());
    return failures ? 1 : 0;
}
