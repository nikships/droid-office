// Host unit tests for the GL-free half of the native scene: math helpers, base64, blob assembly and
// SceneModel (apply, reset, seq, batching, limits), driven by a recorded packet stream.
//   unit <packets.json>
// Exit code 0 when every check passes.
#include "scene_math.h"
#include "scene_model.h"
#include "scene_packet.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>

using namespace office::scene;

namespace {

int checks = 0, failures = 0;

void check(bool ok, const std::string &what) {
    checks++;
    if (ok)
        return;
    failures++;
    std::printf("FAIL: %s\n", what.c_str());
}

bool near(float a, float b, float eps = 1e-4f) { return std::fabs(a - b) <= eps; }

/** True when `f` throws PacketError. */
bool throwsPacketError(const std::function<void()> &f) {
    try {
        f();
    } catch (const PacketError &) {
        return true;
    } catch (...) {
        return false;
    }
    return false;
}

std::string base64(const std::string &s) {
    static const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    for (; i + 3 <= s.size(); i += 3) {
        uint32_t n =
            uint32_t(uint8_t(s[i])) << 16 | uint32_t(uint8_t(s[i + 1])) << 8 | uint8_t(s[i + 2]);
        for (int k = 3; k >= 0; k--)
            out += a[(n >> (6 * k)) & 63];
    }
    size_t rest = s.size() - i;
    if (rest) {
        uint32_t n =
            uint32_t(uint8_t(s[i])) << 16 | (rest > 1 ? uint32_t(uint8_t(s[i + 1])) << 8 : 0);
        out += a[(n >> 18) & 63];
        out += a[(n >> 12) & 63];
        out += rest > 1 ? a[(n >> 6) & 63] : '=';
        out += '=';
    }
    return out;
}

void testMath() {
    Mat4 m = identity();
    m[12] = 2;
    m[13] = -3;
    m[14] = 5;
    Mat4 inv;
    check(invert(m, inv), "invert a translation");
    Mat4 id = multiply(m, inv);
    bool isId = true;
    for (int i = 0; i < 16; i++)
        isId &= near(id[i], identity()[i]);
    check(isId, "m * inverse(m) is the identity");
    Mat4 zero{};
    check(!invert(zero, inv), "a singular matrix does not invert");

    float affine[12] = {2, 0, 0, 0, 3, 0, 0, 0, 4, 1, 1, 1};
    check(near(maxScale(affine), 4), "maxScale is the largest axis scale");
    Sphere s = transformSphere(affine, {{1, 0, 0}, 1});
    check(near(s.c.x, 3) && near(s.c.y, 1) && near(s.c.z, 1) && near(s.r, 4),
          "transformSphere moves and scales");
    Sphere u = unite({{0, 0, 0}, 1}, {{4, 0, 0}, 1});
    check(near(u.c.x, 2) && near(u.r, 3), "unite spans both spheres");
    check(unite({{0, 0, 0}, 5}, {{1, 0, 0}, 1}).r == 5,
          "unite keeps a sphere that contains the other");
    check(unite(Sphere{}, {{1, 2, 3}, 2}).r == 2, "unite with an empty sphere is the other");

    // A symmetric frustum looking down -z: near 1, far 10, 90 degrees.
    Mat4 proj{};
    proj[0] = 1;
    proj[5] = 1;
    proj[10] = -11.0f / 9.0f;
    proj[11] = -1;
    proj[14] = -20.0f / 9.0f;
    Frustum f = Frustum::fromViewProj(proj);
    check(f.intersects({{0, 0, -5}, 0.5f}), "a sphere ahead is inside");
    check(!f.intersects({{0, 0, 5}, 0.5f}), "a sphere behind is outside");
    check(!f.intersects({{0, 0, -20}, 1}), "a sphere past far is outside");
    check(f.intersects({{0, 0, -20}, 11}), "a large sphere across far is inside");
    check(!f.intersects({{20, 0, -5}, 1}), "a sphere off to the side is outside");
    check(f.intersects({{0, 0, 50}, INFINITY}), "an infinite sphere is always inside");
    check(!f.intersects(Sphere{}), "an empty sphere is never inside");

    check(toHalf(1.0f) == 0x3c00, "half 1.0");
    check(toHalf(-2.0f) == 0xc000, "half -2.0");
    check(toHalf(0.0f) == 0, "half 0");
    check(toHalf(65504.0f) == 0x7bff, "half max");
    check(toHalf(1e6f) == 0x7c00, "half overflow is infinity");
    check(toHalf(5.96e-8f) == 1, "half smallest subnormal");
    check((toHalf(NAN) & 0x7c00) == 0x7c00 && (toHalf(NAN) & 0x3ff), "half NaN stays NaN");
    check(packNormal(0, 0, 1) == (511u << 20), "packNormal +z");
    check(packNormal(-1, 0, 0) == (uint32_t(-511) & 0x3ff), "packNormal -x");
    check(packNormal(NAN, 2, 0) == (511u << 10), "packNormal clamps and zeroes NaN");
}

void testBase64() {
    for (const std::string &s : std::vector<std::string>{
             "", "f", "fo", "foo", "foob", "fooba", "foobar", std::string("\0\xff\x10\x80", 4)}) {
        auto out = decodeBase64(base64(s));
        check(std::string(out.begin(), out.end()) == s,
              "base64 round trip of " + std::to_string(s.size()) + " bytes");
    }
    auto unpadded = decodeBase64("Zm9vYg");
    check(std::string(unpadded.begin(), unpadded.end()) == "foob", "base64 without padding");
    check(throwsPacketError([] { decodeBase64("Zm9v!"); }), "base64 rejects a bad character");
    check(throwsPacketError([] { decodeBase64("Zm9vY"); }), "base64 rejects a bad length");
    std::vector<uint8_t> into = {7};
    decodeBase64Into("Zm8=", into);
    check(into.size() == 3 && into[0] == 7 && into[1] == 'f' && into[2] == 'o',
          "decodeBase64Into appends");
}

json part(uint64_t id, uint32_t index, uint32_t parts, size_t bytes, const std::string &data) {
    return {{"id", id}, {"part", index}, {"parts", parts}, {"bytes", bytes}, {"d", base64(data)}};
}

void testBlobs() {
    Limits limits;
    {
        BlobStore b(limits);
        b.add(part(1, 0, 2, 6, "abc"));
        check(b.bytes() == 3, "blob bytes count a partial blob");
        check(throwsPacketError([&] {
                  b.take({{"blob", 1}});
              }),
              "an incomplete blob cannot be taken");
        b.add(part(1, 1, 2, 6, "def"));
        auto out = b.take({{"blob", 1}});
        check(std::string(out.begin(), out.end()) == "abcdef", "blob parts join in order");
        check(b.bytes() == 0, "taking a blob releases its bytes");
        check(throwsPacketError([&] { b.take({{"blob", 1}}); }), "a blob is taken once");
    }
    {
        BlobStore b(limits);
        b.add(part(2, 0, 2, 6, "abc"));
        check(throwsPacketError([&] { b.add(part(2, 0 + 2, 2, 6, "def")); }),
              "a part index past the count is rejected");
        check(throwsPacketError([&] { b.add(part(3, 1, 2, 6, "def")); }),
              "a blob must start at part 0");
        check(throwsPacketError([&] { b.add(part(4, 0, 1, 2, "abc")); }),
              "a blob larger than it said is rejected");
        check(throwsPacketError([&] { b.add(part(5, 0, 1, 4, "abc")); }),
              "a blob smaller than it said is rejected");
        auto inl = b.take({{"d", base64("xyz")}});
        check(std::string(inl.begin(), inl.end()) == "xyz", "inline binary");
    }
    {
        Limits small;
        small.maxBlobBytes = 4;
        BlobStore b(small);
        check(throwsPacketError([&] { b.add(part(1, 0, 2, 8, "abcdef")); }),
              "blobs over the memory limit are rejected");
    }
    check(throwsPacketError([] { asFloats(std::vector<uint8_t>(7), 2, "test"); }),
          "asFloats checks the byte count");
    check(asFloats(std::vector<uint8_t>(8), 2, "test").size() == 2, "asFloats");
}

/** The fixture's one original laptop screen is the only item the screen layer redraws. */
void testSharpState(const RenderState &s, const std::string &when) {
    const DrawItem *screen = nullptr;
    uint32_t tagged = 0, overlays = 0;
    for (const DrawItem &it : s.items) {
        if (it.sharpText) {
            tagged++;
            screen = &it;
        }
        overlays += it.sharpOverlay;
        check(!(it.sharpText && it.sharpOverlay), "no item is both a screen and an overlay");
        if (it.sharpOverlay)
            check(it.material->transparent && !it.material->depthWrite,
                  "overlays are see-through surfaces missing from the world depth");
    }
    check(tagged == 1 && s.sharpItems == 1,
          "exactly one sharp screen item " + when + " (" + std::to_string(tagged) + ")");
    check(overlays > 0, "the office's glass is an overlay candidate " + when);
    if (!screen)
        return;
    const MaterialState &m = *screen->material;
    check(m.sharpText && m.model == ShadeModel::Basic && m.map && !m.transparent,
          "the sharp item is the opaque, mapped basic laptop screen " + when);
    check(screen->mode == DrawMode::Triangles && !screen->instances,
          "the sharp item is a plain triangle draw " + when);
    check(screen->key.sharpDepth == SharpDepth::None && !screen->key.sharpOverlay,
          "the world pass key of the screen is unchanged " + when);
    bool warmed = false, overlayWarm = false, clean = true;
    for (const ProgramKey &k : s.sharpWarmKeys) {
        warmed |= k == screen->key;
        overlayWarm |= k.sharpOverlay;
        clean &= k.sharpDepth == SharpDepth::None;
    }
    check(warmed, "the screen's program is in sharpWarmKeys " + when);
    check(overlayWarm, "overlay programs are in sharpWarmKeys " + when);
    check(clean, "sharpWarmKeys hold color-pass keys (the renderer picks the depth kind)");
}

/** Material edits: an ineligible or untagged screen leaves the layer, a malformed flag rejects. */
void testSharpEdits(const json &packets, SceneModel &m, double t) {
    json screen;
    for (const json &p : packets)
        if (auto mats = p.find("materials"); mats != p.end())
            for (const json &mat : *mats)
                if (mat.value("sharpText", false))
                    screen = mat;
    check(screen.is_object(), "the fixture sends the tagged laptop material");
    if (!screen.is_object())
        return;
    auto edit = [&](const json &mat) {
        json p = {{"v", 1}, {"seq", m.lastSeq() + 1}, {"commit", true}, {"materials", {mat}}};
        return m.apply(p, t += 0.01).state;
    };
    json glassy = screen;
    glassy["transparent"] = true;
    auto s = edit(glassy);
    check(s && s->sharpItems == 0 && s->sharpWarmKeys.empty(),
          "a transparent tagged material is not a sharp screen");
    json untagged = screen;
    untagged.erase("sharpText");
    s = edit(untagged);
    check(s && s->sharpItems == 0, "an untagged screen leaves the layer");
    s = edit(screen);
    check(s && s->sharpItems == 1 && !s->sharpWarmKeys.empty(), "tagging it again brings it back");
    json bad = screen;
    bad["sharpText"] = 1;
    check(throwsPacketError([&] { edit(bad); }), "a non-boolean sharpText is rejected");
}

void testModel(const json &packets) {
    ModelOptions options;
    options.staticAfterSeconds = 1.5f;
    {
        SceneModel m(options);
        json p = packets[1];
        check(throwsPacketError([&] { m.apply(p, 0); }),
              "a stream that does not start with a reset is rejected");
        check(m.needsReset(), "the model waits for a reset");
    }

    SceneModel m(options);
    double t = 0;
    std::shared_ptr<const RenderState> state;
    size_t applied = 0, textures = 0;
    for (const json &p : packets) {
        ApplyResult r = m.apply(p, t);
        applied++;
        textures += r.textures.size();
        if (r.state)
            state = r.state;
        t += 0.001; // the whole stream well inside staticAfterSeconds, so nothing batches yet
    }
    check(applied == packets.size(), "every recorded packet applies");
    check(!m.needsReset(), "the model accepts packets after the reset");
    check(m.commits() > 0 && state, "the stream commits a state");
    check(m.lastSeq() == packets.back().value("seq", 0ull), "lastSeq is the last packet's seq");
    check(textures > 0, "texture uploads come out of apply");
    check(m.blobBytes() == 0, "no blob parts are left over");
    if (!state)
        return;
    check(!state->items.empty(), "the state has draw items");
    check(state->staticBatches == 0, "nothing is batched before the scene holds still");
    check(!state->warmKeys.empty(), "the state lists programs to warm");
    bool itemsWarm = true;
    for (const DrawItem &it : state->items) {
        bool found = false;
        for (const ProgramKey &k : state->warmKeys)
            found |= k == it.key;
        itemsWarm &= found;
    }
    check(itemsWarm, "every drawn program is in warmKeys");
    bool uniqueWarm = true;
    for (size_t i = 0; i < state->warmKeys.size(); i++)
        for (size_t j = i + 1; j < state->warmKeys.size(); j++)
            uniqueWarm &= !(state->warmKeys[i] == state->warmKeys[j]);
    check(uniqueWarm, "warmKeys has no duplicates");
    bool sane = true;
    for (const DrawItem &it : state->items) {
        sane &= it.vertices && it.material && it.count > 0;
        if (it.indices)
            sane &= it.first + it.count <= it.indices->count;
    }
    check(sane, "every item has vertices, a material and an index range inside its buffer");

    testSharpState(*state, "before batching");

    // Holding still merges static meshes into fewer draws.
    size_t before = state->items.size();
    for (int i = 0; i < 120; i++) {
        t += 1.0 / 30;
        ApplyResult r = m.tick(t);
        if (r.state)
            state = r.state;
    }
    check(state->staticBatches > 0 && state->batchedObjects > 0,
          "static batches form after holding still");
    check(state->items.size() < before, "batching reduces the draw items (" +
                                            std::to_string(before) + " -> " +
                                            std::to_string(state->items.size()) + ")");
    check(state->visibleObjects <= state->objects, "visible objects are a subset");
    testSharpState(*state, "after batching");
    testSharpEdits(packets, m, t);

    // Seq gaps and malformed packets ask for a reset, and a reset recovers.
    uint64_t seq = m.lastSeq();
    check(throwsPacketError([&] {
              m.apply({{"v", 1}, {"seq", seq + 5}, {"commit", true}}, t);
          }),
          "a seq gap is rejected");
    check(m.needsReset(), "a seq gap needs a reset");
    check(throwsPacketError([&] {
              m.apply({{"v", 1}, {"seq", seq + 6}, {"commit", true}}, t);
          }),
          "packets are refused until a reset");
    check(throwsPacketError([&] {
              m.apply({{"v", 2}, {"seq", 1}, {"reset", true}}, t);
          }),
          "an unknown version is rejected");
    ApplyResult reset;
    bool ok = true;
    for (const json &p : packets) {
        t += 0.001;
        try {
            ApplyResult r = m.apply(p, t);
            if (r.state)
                reset.state = r.state;
            for (auto &op : r.textures)
                reset.textures.push_back(std::move(op));
        } catch (const PacketError &e) {
            ok = false;
            std::printf("  replay after reset: %s\n", e.what());
            break;
        }
    }
    check(ok && !m.needsReset(), "the recorded stream applies again after a reset");
    check(!reset.textures.empty() && reset.textures.front().kind == TextureOp::Clear,
          "a reset clears the textures first");
    check(reset.state && reset.state->items.size() == before,
          "the reset stream draws what it did the first time");
    check(reset.state && reset.state->serial > state->serial,
          "state serials keep increasing across a reset");

    // A packet that breaks halfway leaves the model waiting for a reset instead of half-applied.
    SceneModel broken(options);
    json first = packets[0];
    json bad = first;
    if (bad.contains("geometries") && !bad["geometries"].empty()) {
        bad["geometries"][0]["count"] = 1u << 30;
        check(throwsPacketError([&] { broken.apply(bad, 0); }),
              "a geometry over the vertex limit is rejected");
        check(broken.needsReset(), "a rejected reset packet still needs a reset");
        bool recovered = true;
        try {
            broken.apply(first, 0);
        } catch (const PacketError &) {
            recovered = false;
        }
        check(recovered, "a good reset after a rejected one applies");
    }
}

} // namespace

int main(int argc, char **argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: unit <packets.json>\n");
        return 2;
    }
    testMath();
    testBase64();
    testBlobs();
    std::ifstream in(argv[1], std::ios::binary);
    std::stringstream buf;
    buf << in.rdbuf();
    json packets = json::parse(buf.str(), nullptr, false);
    if (packets.is_discarded() || !packets.is_array() || packets.empty()) {
        std::fprintf(stderr, "%s is not a JSON array of packets\n", argv[1]);
        return 2;
    }
    testModel(packets);
    std::printf("%d checks, %d failed\n", checks, failures);
    return failures ? 1 : 0;
}
