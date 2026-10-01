// Writes the GLSL for every meaningful ProgramKey, the foveation overlay and the foveation filter
// passes into a directory
// (name.vert, name.frag) for glslangValidator, and checks what can be checked without a GL context:
// the keys' bits() are unique, generation is deterministic, the std140 blocks match
// scene_uniforms.h member for member, and the stages keep the contract (attribute locations, no
// gl_ViewID_OVR in fragment shaders).
//
// With a second directory it also writes every key in the Vulkan dialect (Dialect::Vulkan) there,
// for glslc and spirv-val, and checks that dialect's contract: #version 450 and GL_EXT_multiview,
// no GL-only built-ins, every block and sampler at its set and binding, no default-block uniform,
// the Draw block identical in both stages and member for member DrawBlock (std140 offsets), every
// varying at its fixed location with the same declaration in both stages, and the clip depth
// remap.
//
//   dump <out-dir> [<vulkan-out-dir>]     exit status 0 when every check passes
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "foveation_filter_shader.h"
#include "foveation_overlay_shader.h"
#include "scene_shaders.h"
#include "scene_uniforms.h"

using namespace office::scene;

namespace {

int failures = 0;
bool expectingFailure = false; // a self-test is feeding the checks a deliberately broken input

void fail(const std::string &what) {
    std::fprintf(stderr, "%s %s\n", expectingFailure ? "rejected (expected):" : "FAIL",
                 what.c_str());
    ++failures;
}

// The std140 layout of one member list, computed the way GLSL does, to compare against the structs.
struct Member {
    std::string type, name;
    int count; // 1 when not an array
};

// A strict reader of the generated block bodies. Each member is exactly
//   [highp|mediump|lowp] <type> <name>['[' <decimal count> ']'] ;
// with whitespace separating the words and none inside or before the brackets; anything else in
// the body is an error, not skipped text.
class BlockReader {
  public:
    BlockReader(const std::string &s, size_t at) : s_(s), i_(at) {}

    void space() {
        while (i_ < s_.size() && std::isspace(static_cast<unsigned char>(s_[i_])))
            ++i_;
    }
    bool eat(char c) {
        if (i_ < s_.size() && s_[i_] == c) {
            ++i_;
            return true;
        }
        return false;
    }
    bool atSpace() const {
        return i_ < s_.size() && std::isspace(static_cast<unsigned char>(s_[i_]));
    }
    std::string word() {
        const size_t from = i_;
        if (i_ < s_.size() && !std::isdigit(static_cast<unsigned char>(s_[i_])))
            while (i_ < s_.size() &&
                   (std::isalnum(static_cast<unsigned char>(s_[i_])) || s_[i_] == '_'))
                ++i_;
        return s_.substr(from, i_ - from);
    }
    // A positive decimal count that fits an int; 0 on anything else.
    int count() {
        long long n = 0;
        const size_t from = i_;
        while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_])) && n <= 1000000)
            n = n * 10 + (s_[i_++] - '0');
        if (i_ == from || n <= 0 || n > 1000000 ||
            (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))))
            return 0;
        return int(n);
    }
    size_t pos() const { return i_; }

  private:
    const std::string &s_;
    size_t i_;
};

enum class Parse { Absent, Ok, Malformed };

Parse readBlock(const std::string &src, const std::string &block, std::vector<Member> &out,
                std::string &error) {
    out.clear();
    const std::string head = "uniform " + block;
    size_t at = std::string::npos;
    for (size_t from = 0;;) {
        const size_t found = src.find(head, from);
        if (found == std::string::npos)
            break;
        from = found + head.size();
        const bool wordStart =
            found == 0 || std::isspace(static_cast<unsigned char>(src[found - 1]));
        const bool wordEnd =
            from == src.size() ||
            !(std::isalnum(static_cast<unsigned char>(src[from])) || src[from] == '_');
        if (!wordStart || !wordEnd)
            continue;
        if (at != std::string::npos) {
            error = "declared twice";
            return Parse::Malformed;
        }
        at = from;
    }
    if (at == std::string::npos)
        return Parse::Absent;
    BlockReader r(src, at);
    r.space();
    if (!r.eat('{')) {
        error = "no '{' after " + head;
        return Parse::Malformed;
    }
    for (;;) {
        r.space();
        if (r.eat('}'))
            break;
        const size_t start = r.pos();
        auto bad = [&](const char *what) {
            error = std::string(what) + " at offset " + std::to_string(start) + ": " +
                    src.substr(start, std::min<size_t>(40, src.size() - start));
            return Parse::Malformed;
        };
        std::string type = r.word();
        if (type.empty())
            return bad("expected a member or '}'");
        if (type == "highp" || type == "mediump" || type == "lowp") {
            if (!r.atSpace())
                return bad("no space after the precision");
            r.space();
            type = r.word();
            if (type.empty())
                return bad("no type after the precision");
        }
        if (!r.atSpace())
            return bad("no space after the type");
        r.space();
        const std::string name = r.word();
        if (name.empty())
            return bad("no member name");
        int count = 1;
        if (r.eat('[')) {
            count = r.count();
            if (count == 0 || !r.eat(']'))
                return bad("array size is not a positive decimal in []");
        }
        r.space();
        if (!r.eat(';'))
            return bad("no ';' after the member");
        out.push_back({type, name, count});
    }
    if (out.empty()) {
        error = "empty block";
        return Parse::Malformed;
    }
    return Parse::Ok;
}

// Reads the members of `uniform <block> { ... }` from src. Absent when src declares no such
// block; Malformed (with `error`, and no members) when a declaration does not follow the member
// grammar, the block is declared twice, or its body is empty or not closed.
Parse parseBlock(const std::string &src, const std::string &block, std::vector<Member> &out,
                 std::string &error) {
    const Parse p = readBlock(src, block, out, error);
    if (p != Parse::Ok)
        out.clear();
    return p;
}

// The parser must reject every malformed declaration below, and read the well-formed ones
// member for member; otherwise the block checks could pass on text they never read.
void selfTestParser() {
    struct Case {
        const char *src;
        Parse want;
        std::vector<Member> members;
    };
    const Case cases[] = {
        {"layout(std140) uniform View {\n  highp mat4 viewProj[2];\n  highp vec4 viewport;\n} "
         "uView;",
         Parse::Ok,
         {{"mat4", "viewProj", 2}, {"vec4", "viewport", 1}}},
        {"uniform View{mat4 a[3] ;lowp vec4 b;}", Parse::Ok, {{"mat4", "a", 3}, {"vec4", "b", 1}}},
        {"uniform View { mat4 a [3]; }", Parse::Malformed, {}},
        {"uniform View { mat4 a[ 3]; }", Parse::Malformed, {}},
        {"uniform Views { vec4 a; }", Parse::Absent, {}},
        {"uniform NotView { vec4 a; }", Parse::Absent, {}},
        {"no block here", Parse::Absent, {}},
        {"uniform View { highp vec4 a }", Parse::Malformed, {}},     // missing ;
        {"uniform View { highp vec4 a;", Parse::Malformed, {}},      // not closed
        {"uniform View { }", Parse::Malformed, {}},                  // empty
        {"uniform View vec4 a; }", Parse::Malformed, {}},            // no {
        {"uniform View { highp vec4 a[N]; }", Parse::Malformed, {}}, // not a decimal
        {"uniform View { highp vec4 a[0]; }", Parse::Malformed, {}},
        {"uniform View { highp vec4 a[-2]; }", Parse::Malformed, {}},
        {"uniform View { highp vec4 a[2; }", Parse::Malformed, {}},
        {"uniform View { highp vec4 a[99999999999]; }", Parse::Malformed, {}},
        {"uniform View { highp vec4; }", Parse::Malformed, {}},                // no name
        {"uniform View { highp; }", Parse::Malformed, {}},                     // no type
        {"uniform View { highpvec4 a; }", Parse::Ok, {{"highpvec4", "a", 1}}}, // a type, not highp
        {"uniform View { vec4 a; garbage }", Parse::Malformed, {}}, // trailing text is not skipped
        {"uniform View { vec4 a; vec4 b c; }", Parse::Malformed, {}},
        {"uniform View { vec4 a; ; }", Parse::Malformed, {}},
        {"uniform View { vec4 a; }\nuniform View { vec4 a; }", Parse::Malformed, {}},
        {"uniform View { mat4 m[2] ; vec4 1x; }", Parse::Malformed, {}},
    };
    for (const Case &c : cases) {
        std::vector<Member> got;
        std::string error;
        const Parse p = parseBlock(c.src, "View", got, error);
        bool same = p == c.want && got.size() == c.members.size();
        for (size_t i = 0; same && i < got.size(); ++i)
            same = got[i].type == c.members[i].type && got[i].name == c.members[i].name &&
                   got[i].count == c.members[i].count;
        if (!same)
            fail(std::string("block parser self-test (result ") + std::to_string(int(p)) +
                 ", want " + std::to_string(int(c.want)) + ", " + std::to_string(got.size()) +
                 " members, error '" + error + "'): " + c.src);
    }
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

// The layout qualifier generateShader gives block `name` (Vulkan: its set and binding).
std::string blockHead(const std::string &name, bool vulkan) {
    if (!vulkan)
        return "layout(std140) uniform " + name + " {";
    const uint32_t binding = name == "View" ? kBlockView : name == "Frame" ? kBlockFrame : kBlockSky;
    return "layout(std140, set = " + std::to_string(kSetFrame) +
           ", binding = " + std::to_string(binding) + ") uniform " + name + " {";
}

void checkBlocks(const std::string &prog, const std::string &stage, const std::string &src,
                 bool vulkan = false) {
    for (const char *name : {"View", "Frame", "Sky"}) {
        std::vector<Member> got;
        std::string error;
        const Parse parsed = parseBlock(src, name, got, error);
        if (parsed == Parse::Absent)
            continue;
        if (parsed == Parse::Malformed) {
            fail(prog + "." + stage + ": block " + name + " is malformed: " + error);
            continue;
        }
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
        if (src.find(blockHead(name, vulkan)) == std::string::npos)
            fail(prog + "." + stage + ": block " + name + " is not " + blockHead(name, vulkan));
    }
}

// ---- The Vulkan dialect -------------------------------------------------------------------------

// std140 base alignment and size of the member types the Draw block uses.
bool std140Type(const std::string &type, size_t &align, size_t &size) {
    if (type == "float" || type == "int") {
        align = size = 4;
    } else if (type == "vec2") {
        align = size = 8;
    } else if (type == "vec3") {
        align = 16;
        size = 12;
    } else if (type == "vec4" || type == "ivec4") {
        align = size = 16;
    } else if (type == "mat3") {
        align = 16;
        size = 48; // three vec3 columns, each padded to a vec4
    } else if (type == "mat4") {
        align = 16;
        size = 64;
    } else {
        return false;
    }
    return true;
}

// The std140 layout of non-array members (GLSL 4.50 7.6.2.2), offsets by name; returns the block
// size rounded up to 16.
size_t std140Layout(const std::vector<Member> &ms, std::map<std::string, size_t> &offsets) {
    size_t off = 0;
    for (const Member &m : ms) {
        size_t align = 0, size = 0;
        if (m.count != 1 || !std140Type(m.type, align, size)) {
            fail("Draw member " + m.type + " " + m.name + " has no std140 rule here");
            continue;
        }
        off = (off + align - 1) / align * align;
        offsets[m.name] = off;
        off += size;
    }
    return (off + 15) / 16 * 16;
}

const std::vector<Member> &expectedDraw() {
    static const std::vector<Member> draw = {
        {"mat4", "uModel", 1},          {"mat4", "uLightViewProj", 1},
        {"mat3", "uNormalMatrix", 1},   {"mat3", "uMapTransform", 1},
        {"mat3", "uAlphaMapTransform", 1}, {"mat3", "uEmissiveMapTransform", 1},
        {"vec4", "uColor", 1},          {"vec4", "uSpecular", 1},
        {"vec4", "uSky0", 1},           {"vec4", "uSky1", 1},
        {"vec4", "uSky2", 1},           {"vec4", "uSky3", 1},
        {"vec4", "uSky4", 1},           {"vec4", "uSharpRect", 1},
        {"vec4", "uSharpParams", 1},    {"vec4", "uSharpBias", 1},
        {"vec3", "uEmissive", 1},       {"float", "uAlphaTest", 1},
        {"vec2", "uMetalRough", 1},     {"vec2", "uSpriteCenter", 1},
        {"float", "uReceiveShadow", 1}, {"float", "uPointSize", 1},
        {"float", "uSpriteRotation", 1}, {"int", "uPointQuad", 1},
    };
    return draw;
}

// DrawBlock's offsets, from the compiler.
const std::map<std::string, size_t> &drawOffsets() {
    static const std::map<std::string, size_t> o = {
        {"uModel", offsetof(DrawBlock, model)},
        {"uLightViewProj", offsetof(DrawBlock, lightViewProj)},
        {"uNormalMatrix", offsetof(DrawBlock, normalMatrix)},
        {"uMapTransform", offsetof(DrawBlock, mapTransform)},
        {"uAlphaMapTransform", offsetof(DrawBlock, alphaMapTransform)},
        {"uEmissiveMapTransform", offsetof(DrawBlock, emissiveMapTransform)},
        {"uColor", offsetof(DrawBlock, color)},
        {"uSpecular", offsetof(DrawBlock, specular)},
        {"uSky0", offsetof(DrawBlock, sky)},
        {"uSky1", offsetof(DrawBlock, sky) + 16},
        {"uSky2", offsetof(DrawBlock, sky) + 32},
        {"uSky3", offsetof(DrawBlock, sky) + 48},
        {"uSky4", offsetof(DrawBlock, sky) + 64},
        {"uSharpRect", offsetof(DrawBlock, sharpRect)},
        {"uSharpParams", offsetof(DrawBlock, sharpParams)},
        {"uSharpBias", offsetof(DrawBlock, sharpBias)},
        {"uEmissive", offsetof(DrawBlock, emissive)},
        {"uAlphaTest", offsetof(DrawBlock, alphaTest)},
        {"uMetalRough", offsetof(DrawBlock, metalRough)},
        {"uSpriteCenter", offsetof(DrawBlock, spriteCenter)},
        {"uReceiveShadow", offsetof(DrawBlock, receiveShadow)},
        {"uPointSize", offsetof(DrawBlock, pointSize)},
        {"uSpriteRotation", offsetof(DrawBlock, spriteRotation)},
        {"uPointQuad", offsetof(DrawBlock, pointQuad)},
    };
    return o;
}

// The text of `uniform Draw { ... };` in src, or empty.
std::string drawBlockText(const std::string &src) {
    const size_t at = src.find("uniform Draw {");
    if (at == std::string::npos)
        return {};
    const size_t end = src.find("};\n", at);
    return end == std::string::npos ? std::string() : src.substr(at, end + 3 - at);
}

std::vector<std::string> lines(const std::string &src) {
    std::vector<std::string> out;
    size_t from = 0;
    while (from < src.size()) {
        size_t end = src.find('\n', from);
        if (end == std::string::npos)
            end = src.size();
        out.push_back(src.substr(from, end - from));
        from = end + 1;
    }
    return out;
}

bool startsWith(const std::string &s, const std::string &prefix) {
    return s.compare(0, prefix.size(), prefix) == 0;
}

// The set and binding each Vulkan resource must have (scene_uniforms.h).
bool expectedBinding(const std::string &name, uint32_t &set, uint32_t &binding) {
    const std::map<std::string, std::pair<uint32_t, uint32_t>> table = {
        {"View", {kSetFrame, kBlockView}},
        {"Frame", {kSetFrame, kBlockFrame}},
        {"Sky", {kSetFrame, kBlockSky}},
        {"uShadowMap", {kSetFrame, uint32_t(kUnitShadowMap)}},
        {"uSharpDepth", {kSetFrame, uint32_t(kUnitSharpDepth)}},
        {"uMap", {kSetMaterial, uint32_t(kUnitMap)}},
        {"uAlphaMap", {kSetMaterial, uint32_t(kUnitAlphaMap)}},
        {"uEmissiveMap", {kSetMaterial, uint32_t(kUnitEmissiveMap)}},
        {"uGradientMap", {kSetMaterial, uint32_t(kUnitGradientMap)}},
        {"Draw", {kSetDraw, kBindingDraw}},
    };
    auto it = table.find(name);
    if (it == table.end())
        return false;
    set = it->second.first;
    binding = it->second.second;
    return true;
}

// Every `uniform` of a Vulkan stage: a block or a sampler, at its expected set and binding, once.
void checkVulkanResources(const std::string &prog, const std::string &stage,
                          const std::string &src) {
    std::set<std::pair<uint32_t, uint32_t>> used;
    for (const std::string &line : lines(src)) {
        const size_t u = line.find("uniform ");
        if (u == std::string::npos || (u > 0 && line[u - 1] != ' '))
            continue;
        unsigned set = 0, binding = 0;
        if (std::sscanf(line.c_str(), "layout(set = %u, binding = %u) uniform", &set, &binding) !=
                2 &&
            std::sscanf(line.c_str(), "layout(std140, set = %u, binding = %u) uniform", &set,
                        &binding) != 2) {
            fail(prog + "." + stage + ": a uniform without a set and binding: " + line);
            continue;
        }
        // The resource's name: the block name, or a sampler's last word.
        std::string rest = line.substr(u + 8), name;
        const bool block = rest.find('{') != std::string::npos;
        if (block) {
            name = rest.substr(0, rest.find(' '));
        } else {
            if (rest.find("sampler") == std::string::npos)
                fail(prog + "." + stage + ": a default-block uniform in the Vulkan dialect: " +
                     line);
            const size_t semi = rest.rfind(';'), space = rest.rfind(' ', semi);
            name = rest.substr(space + 1, semi - space - 1);
        }
        uint32_t wantSet = 0, wantBinding = 0;
        if (!expectedBinding(name, wantSet, wantBinding))
            fail(prog + "." + stage + ": unknown Vulkan resource " + name);
        else if (set != wantSet || binding != wantBinding)
            fail(prog + "." + stage + ": " + name + " at set " + std::to_string(set) +
                 " binding " + std::to_string(binding));
        if (!used.insert({set, binding}).second)
            fail(prog + "." + stage + ": set " + std::to_string(set) + " binding " +
                 std::to_string(binding) + " declared twice");
    }
}

struct Varying {
    int location;
    std::string declaration; // "[flat ]<type> <name>"
};

// The `layout(location = N) [flat ]in|out <type> <name>;` declarations of `direction` in src,
// except the vertex attributes and the fragment color; any other in/out without a location fails.
std::map<std::string, Varying> varyings(const std::string &prog, const std::string &stage,
                                        const std::string &src, const std::string &direction) {
    std::map<std::string, Varying> out;
    std::set<int> locations;
    for (const std::string &line : lines(src)) {
        std::string body = line;
        int location = -1;
        if (startsWith(body, "layout(location = ")) {
            location = std::atoi(body.c_str() + 18);
            body = body.substr(body.find(") ") + 2);
        }
        std::string flat;
        if (startsWith(body, "flat ")) {
            flat = "flat ";
            body = body.substr(5);
        }
        if (!startsWith(body, direction + " ") || body.back() != ';')
            continue;
        const std::string decl = body.substr(direction.size() + 1, body.size() - direction.size() - 2);
        const std::string name = decl.substr(decl.rfind(' ') + 1);
        if (name == "pc_fragColor" || (name.size() > 1 && name[0] == 'a' && direction == "in"))
            continue; // the color output and the vertex attributes
        if (location < 0) {
            fail(prog + "." + stage + ": " + direction + " " + name + " has no location");
            continue;
        }
        if (!locations.insert(location).second)
            fail(prog + "." + stage + ": location " + std::to_string(location) + " used twice");
        out[name] = {location, flat + decl};
    }
    return out;
}

void checkVulkanStages(const ProgramKey &k, const std::string &prog, const ShaderSource &s) {
    if (s.vertex.rfind("#version 450\n", 0) != 0 || s.fragment.rfind("#version 450\n", 0) != 0)
        fail(prog + ": not #version 450 first");
    const bool mv = k.multiview && k.model != ShadeModel::Depth;
    if (mv != (s.vertex.find("#extension GL_EXT_multiview : require\n") != std::string::npos))
        fail(prog + ": GL_EXT_multiview " + (mv ? "missing" : "unexpected"));
    if (s.fragment.find("multiview") != std::string::npos ||
        s.fragment.find("gl_ViewIndex") != std::string::npos)
        fail(prog + ": the fragment stage uses multiview");
    for (const char *gles : {"gl_ViewID_OVR", "gl_VertexID", "num_views", "#version 300 es"})
        if (s.vertex.find(gles) != std::string::npos || s.fragment.find(gles) != std::string::npos)
            fail(prog + ": GLSL ES only " + gles);
    checkVulkanResources(prog, "vert", s.vertex);
    checkVulkanResources(prog, "frag", s.fragment);
    checkBlocks(prog, "vert", s.vertex, true);
    checkBlocks(prog, "frag", s.fragment, true);
    // The Draw block: both stages, the same text, DrawBlock's members and offsets.
    const std::string drawV = drawBlockText(s.vertex), drawF = drawBlockText(s.fragment);
    if (drawV.empty() || drawV != drawF)
        fail(prog + ": the Draw block is missing or differs between the stages");
    std::vector<Member> draw;
    std::string error;
    if (parseBlock(s.vertex, "Draw", draw, error) != Parse::Ok) {
        fail(prog + ": the Draw block is malformed: " + error);
    } else {
        const auto &want = expectedDraw();
        bool same = draw.size() == want.size();
        for (size_t i = 0; same && i < draw.size(); ++i)
            same = draw[i].type == want[i].type && draw[i].name == want[i].name &&
                   draw[i].count == want[i].count;
        if (!same)
            fail(prog + ": the Draw block does not match DrawBlock");
        std::map<std::string, size_t> offsets;
        if (std140Layout(draw, offsets) != sizeof(DrawBlock))
            fail(prog + ": the Draw block's std140 size is not sizeof(DrawBlock)");
        for (const auto &[member, off] : drawOffsets())
            if (offsets.count(member) == 0 || offsets[member] != off)
                fail(prog + ": Draw." + member + " std140 offset " +
                     std::to_string(offsets[member]) + ", DrawBlock " + std::to_string(off));
    }
    // Every fragment input matches a vertex output at the same location, declared the same way.
    const auto outs = varyings(prog, "vert", s.vertex, "out");
    const auto ins = varyings(prog, "frag", s.fragment, "in");
    for (const auto &[name, in] : ins) {
        auto it = outs.find(name);
        if (it == outs.end())
            fail(prog + ": fragment input " + name + " has no vertex output");
        else if (it->second.location != in.location || it->second.declaration != in.declaration)
            fail(prog + ": " + name + " differs between the stages");
    }
    const std::string remap = "\tgl_Position.z = ( gl_Position.z + gl_Position.w ) * 0.5;\n}\n";
    if (s.vertex.size() < remap.size() ||
        s.vertex.compare(s.vertex.size() - remap.size(), remap.size(), remap) != 0)
        fail(prog + ": the vertex stage does not end with the clip depth remap");
    if (k.model == ShadeModel::Points && s.vertex.find("gl_VertexIndex") == std::string::npos)
        fail(prog + ": Vulkan points are not drawn as quads");
}

// checkVulkanStages must reject real generated stages broken in each way the contract covers.
void selfTestVulkanChecks() {
    ProgramKey k;
    k.model = ShadeModel::Toon;
    k.multiview = true;
    k.sky = true;
    k.fog = FogMode::Linear;
    k.map = k.shadows = k.gradientMap = true;
    const ShaderSource src = generateShader(k, Dialect::Vulkan);
    const struct {
        const char *what;
        bool vertex;
        const char *from, *to;
    } mutations[] = {
        {"GLES version", true, "#version 450\n", "#version 300 es\n"},
        {"no multiview extension", true, "#extension GL_EXT_multiview : require\n", ""},
        {"default-block uniform", false, "layout(location = 0) out highp vec4 pc_fragColor;",
         "uniform float uExtra;\nlayout(location = 0) out highp vec4 pc_fragColor;"},
        {"sampler binding", false, "binding = 0) uniform sampler2D uMap;",
         "binding = 3) uniform sampler2D uMap;"},
        {"block set", true, "layout(std140, set = 0, binding = 2) uniform View {",
         "layout(std140, set = 1, binding = 2) uniform View {"},
        {"Draw differs", false, "  highp float uAlphaTest;\n", "  highp int uAlphaTest;\n"},
        {"varying location", false, "layout(location = 0) in vec2 vMapUv;",
         "layout(location = 3) in vec2 vMapUv;"},
        {"varying without location", false, "layout(location = 0) in vec2 vMapUv;",
         "in vec2 vMapUv;"},
        {"no depth remap", true, "\tgl_Position.z = ( gl_Position.z + gl_Position.w ) * 0.5;\n",
         ""},
        {"gl_ViewID_OVR", true, "gl_ViewIndex", "gl_ViewID_OVR"},
    };
    for (const auto &m : mutations) {
        ShaderSource bad = src;
        std::string &text = m.vertex ? bad.vertex : bad.fragment;
        const size_t at = text.find(m.from);
        if (at == std::string::npos) {
            fail(std::string("Vulkan check self-test: '") + m.from + "' is not in the stage");
            continue;
        }
        text.replace(at, std::strlen(m.from), m.to);
        const int before = failures;
        expectingFailure = true;
        checkVulkanStages(k, std::string("self-test (") + m.what + ")", bad);
        expectingFailure = false;
        if (failures == before)
            fail(std::string("Vulkan check self-test: ") + m.what + " passed");
        else
            failures = before;
    }
    const int before = failures;
    checkVulkanStages(k, "self-test", src);
    if (failures != before)
        fail("Vulkan check self-test: the unchanged stages fail");
}

// checkBlocks must reject real generated blocks with one declaration broken in each way the
// contract covers.
void selfTestBlockChecks() {
    ProgramKey k;
    k.model = ShadeModel::Standard;
    k.sky = true;
    k.fog = FogMode::Linear;
    const std::string src = generateShader(k).vertex;
    const struct {
        const char *what, *from, *to;
    } mutations[] = {
        {"missing ';'", "highp vec4 viewport;", "highp vec4 viewport"},
        {"renamed member", "highp vec4 viewport;", "highp vec4 viewPort;"},
        {"wrong type", "highp vec4 viewport;", "highp vec3 viewport;"},
        {"wrong array size", "cameraPos[2];", "cameraPos[3];"},
        {"symbolic array size", "cameraPos[2];", "cameraPos[N];"},
        {"dropped array", "cameraPos[2];", "cameraPos;"},
        {"extra text", "highp vec4 viewport;", "highp vec4 viewport; junk"},
        {"extra member", "highp vec4 viewport;", "highp vec4 viewport;\n  highp vec4 extra;"},
        {"reordered", "highp mat4 view[2];\n  highp mat4 proj[2];",
         "highp mat4 proj[2];\n  highp mat4 view[2];"},
        {"not std140", "layout(std140) uniform View {", "layout(shared) uniform View {"},
        {"not closed", "} uView;", "uView;"},
    };
    for (const auto &m : mutations) {
        std::string bad = src;
        const size_t at = bad.find(m.from);
        if (at == std::string::npos) {
            fail(std::string("block check self-test: '") + m.from + "' is not in the View block");
            continue;
        }
        bad.replace(at, std::strlen(m.from), m.to);
        const int before = failures;
        expectingFailure = true;
        checkBlocks(std::string("self-test (") + m.what + ")", "vert", bad);
        expectingFailure = false;
        if (failures == before)
            fail(std::string("block check self-test: ") + m.what + " passed");
        else
            failures = before;
    }
    const int before = failures;
    checkBlocks("self-test", "vert", src);
    if (failures != before)
        fail("block check self-test: the unchanged View block fails");
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
    if (argc != 2 && argc != 3) {
        std::fprintf(stderr, "usage: dump <out-dir> [<vulkan-out-dir>]\n");
        return 2;
    }
    const std::string dir = argv[1];
    const std::string vkDir = argc == 3 ? argv[2] : "";
    selfTestParser();
    selfTestBlockChecks();
    if (!vkDir.empty()) {
        selfTestVulkanChecks();
        // For vulkan-stages.sh: glslang's reflection of every stage must agree with DrawBlock.
        std::ofstream offsets(vkDir + "/draw-offsets.txt");
        offsets << "size " << sizeof(DrawBlock) << "\n";
        for (const auto &[member, off] : drawOffsets())
            offsets << member << " " << off << "\n";
    }

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
        if (!vkDir.empty()) {
            const ShaderSource v = generateShader(k, Dialect::Vulkan);
            const ShaderSource vAgain = generateShader(k, Dialect::Vulkan);
            if (v.vertex != vAgain.vertex || v.fragment != vAgain.fragment)
                fail("nondeterministic Vulkan " + programName(k));
            checkVulkanStages(k, prog, v);
            std::ofstream(vkDir + "/" + prog + ".vert") << v.vertex;
            std::ofstream(vkDir + "/" + prog + ".frag") << v.fragment;
        }
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

    // The foveation diagnostic view is not a scene program. Its stages go through the same
    // glslangValidator compile and link steps in check.sh.
    for (bool multiview : {true, false}) {
        const auto s = office::foveationOverlayShader(multiview);
        const std::string prog =
            multiview ? "foveation_overlay.multiview" : "foveation_overlay.single";
        if (s.fragment.find("gl_ViewID_OVR") != std::string::npos)
            fail(prog + ": fragment stage uses gl_ViewID_OVR");
        std::ofstream(dir + "/" + prog + ".vert") << s.vertex;
        std::ofstream(dir + "/" + prog + ".frag") << s.fragment;
    }

    // The foveation filter's two passes share one vertex stage; each is written as a program.
    for (bool multiview : {true, false}) {
        const auto s = office::foveationFilterShaders(multiview);
        const std::string view = multiview ? "multiview" : "single";
        for (const auto &[name, fragment] :
             {std::pair<std::string, std::string>{"foveation_density", s.densityFragment},
              {"foveation_resolve", s.resolveFragment}}) {
            const std::string prog = name + "." + view;
            if (fragment.find("gl_ViewID_OVR") != std::string::npos)
                fail(prog + ": fragment stage uses gl_ViewID_OVR");
            std::ofstream(dir + "/" + prog + ".vert") << s.vertex;
            std::ofstream(dir + "/" + prog + ".frag") << fragment;
        }
    }

    // Points are quads in the world pass (QCOM_texture_foveated issue 4 leaves gl_PointSize
    // unscaled in foveated bins), with GL points kept for indexed draws.
    for (const ProgramKey &k : keys) {
        if (k.model != ShadeModel::Points)
            continue;
        const ShaderSource s = generateShader(k);
        const std::string prog = programName(k);
        if (s.vertex.find("if ( uPointQuad != 0 )") == std::string::npos ||
            s.vertex.find("gl_VertexID") == std::string::npos)
            fail(prog + ": points are not drawn as quads");
        if (s.fragment.find("gl_PointCoord") != std::string::npos &&
            s.fragment.find("vPointCoord.x < 0.0 ? gl_PointCoord : vPointCoord") ==
                std::string::npos)
            fail(prog + ": a quad point reads gl_PointCoord");
    }

    std::printf("programs %d (from %zu keys), 2 foveation overlay programs and 4 foveation "
                "filter programs\n",
                programs, keys.size());
    return failures ? 1 : 0;
}
