// Prints, as JSON, the GLSL for keys given by their programName() spelling, e.g.
//   emit toon+gradient+sky+fog+shadow+srgbout basic+map+alphatest
// -> {"toon+gradient+...": {"vertex": "...", "fragment": "..."}, ...}
// compare.mjs feeds this to the browser harness. Exit status 2 on a name it cannot parse.
#include <cstdio>
#include <cstring>
#include <string>

#include "scene_shaders.h"

using namespace office::scene;

namespace {

bool parse(const std::string &name, ProgramKey &k) {
    static const struct {
        const char *s;
        ShadeModel m;
    } models[] = {{"basic", ShadeModel::Basic},       {"toon", ShadeModel::Toon},
                  {"lambert", ShadeModel::Lambert},   {"phong", ShadeModel::Phong},
                  {"standard", ShadeModel::Standard}, {"points", ShadeModel::Points},
                  {"line", ShadeModel::Line},         {"sprite", ShadeModel::Sprite},
                  {"beam", ShadeModel::Beam},         {"skydome", ShadeModel::SkyDome},
                  {"depth", ShadeModel::Depth}};
    size_t start = 0;
    bool first = true;
    while (start <= name.size()) {
        size_t end = name.find('+', start);
        if (end == std::string::npos)
            end = name.size();
        const std::string t = name.substr(start, end - start);
        start = end + 1;
        if (first) {
            first = false;
            bool found = false;
            for (const auto &m : models)
                if (t == m.s)
                    k.model = m.m, found = true;
            if (!found)
                return false;
            continue;
        }
        if (t == "map")
            k.map = true;
        else if (t == "alphamap")
            k.alphaMap = true;
        else if (t == "emissive")
            k.emissiveMap = true;
        else if (t == "gradient")
            k.gradientMap = true;
        else if (t == "alphatest")
            k.alphaTest = true;
        else if (t == "opaque")
            k.opaque = true;
        else if (t == "premul")
            k.premultipliedAlpha = true;
        else if (t == "double")
            k.doubleSided = true;
        else if (t == "back")
            k.backSide = true;
        else if (t == "flat")
            k.flatShading = true;
        else if (t == "fixedsize")
            k.sizeAttenuation = false;
        else if (t == "sky")
            k.sky = true;
        else if (t == "fog")
            k.fog = FogMode::Linear;
        else if (t == "fog2")
            k.fog = FogMode::Exp2;
        else if (t == "shadow")
            k.shadows = true;
        else if (t == "srgbout")
            k.linearOutput = false;
        else if (t == "mv")
            k.multiview = true;
        else
            return false;
    }
    return true;
}

std::string json(const std::string &s) {
    std::string o = "\"";
    for (char c : s) {
        switch (c) {
        case '"':
            o += "\\\"";
            break;
        case '\\':
            o += "\\\\";
            break;
        case '\n':
            o += "\\n";
            break;
        case '\t':
            o += "\\t";
            break;
        default:
            o += c;
        }
    }
    return o + "\"";
}

} // namespace

int main(int argc, char **argv) {
    std::string out = "{";
    for (int i = 1; i < argc; ++i) {
        ProgramKey k;
        if (!parse(argv[i], k)) {
            std::fprintf(stderr, "cannot parse key %s\n", argv[i]);
            return 2;
        }
        if (programName(k) != argv[i]) {
            std::fprintf(stderr, "key %s round-trips as %s\n", argv[i], programName(k).c_str());
            return 2;
        }
        const ShaderSource s = generateShader(k);
        if (i > 1)
            out += ",";
        out += json(argv[i]) + ":{\"vertex\":" + json(s.vertex) +
               ",\"fragment\":" + json(s.fragment) + "}";
    }
    out += "}\n";
    std::fputs(out.c_str(), stdout);
    return 0;
}
