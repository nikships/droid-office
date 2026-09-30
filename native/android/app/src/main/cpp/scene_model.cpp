#include "scene_model.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

namespace office::scene {

uint64_t nextSerial() {
    static std::atomic<uint64_t> serial{1};
    return serial.fetch_add(1, std::memory_order_relaxed);
}

namespace {

// GL enum values, spelled out so this file stays GL-free.
constexpr uint32_t GL_NEVER_ = 0x0200, GL_LESS_ = 0x0201, GL_EQUAL_ = 0x0202, GL_LEQUAL_ = 0x0203,
                   GL_GREATER_ = 0x0204, GL_NOTEQUAL_ = 0x0205, GL_GEQUAL_ = 0x0206,
                   GL_ALWAYS_ = 0x0207;
constexpr uint32_t GL_NEAREST_ = 0x2600, GL_LINEAR_ = 0x2601, GL_NEAREST_MIPMAP_NEAREST_ = 0x2700,
                   GL_LINEAR_MIPMAP_NEAREST_ = 0x2701, GL_NEAREST_MIPMAP_LINEAR_ = 0x2702,
                   GL_LINEAR_MIPMAP_LINEAR_ = 0x2703;
constexpr uint32_t GL_REPEAT_ = 0x2901, GL_CLAMP_TO_EDGE_ = 0x812F, GL_MIRRORED_REPEAT_ = 0x8370;

uint32_t depthFunc(const std::string &s) {
    if (s == "never")
        return GL_NEVER_;
    if (s == "less")
        return GL_LESS_;
    if (s == "equal")
        return GL_EQUAL_;
    if (s == "greater")
        return GL_GREATER_;
    if (s == "notequal")
        return GL_NOTEQUAL_;
    if (s == "gequal")
        return GL_GEQUAL_;
    if (s == "always")
        return GL_ALWAYS_;
    return GL_LEQUAL_;
}

uint32_t equation(const std::string &s) {
    if (s == "subtract")
        return 0x800A;
    if (s == "reverseSubtract")
        return 0x800B;
    if (s == "min")
        return 0x8007;
    if (s == "max")
        return 0x8008;
    return 0x8006;
}

uint32_t factor(const std::string &s) {
    static const std::pair<const char *, uint32_t> table[] = {
        {"zero", 0},
        {"one", 1},
        {"srcColor", 0x0300},
        {"oneMinusSrcColor", 0x0301},
        {"srcAlpha", 0x0302},
        {"oneMinusSrcAlpha", 0x0303},
        {"dstAlpha", 0x0304},
        {"oneMinusDstAlpha", 0x0305},
        {"dstColor", 0x0306},
        {"oneMinusDstColor", 0x0307},
        {"srcAlphaSaturate", 0x0308},
        {"constantColor", 0x8001},
        {"oneMinusConstantColor", 0x8002},
        {"constantAlpha", 0x8003},
        {"oneMinusConstantAlpha", 0x8004},
    };
    for (const auto &[name, value] : table)
        if (s == name)
            return value;
    throw PacketError("unknown blend factor \"" + s + "\"");
}

uint32_t filter(const std::string &s) {
    if (s == "nearest")
        return GL_NEAREST_;
    if (s == "nearestMipNearest")
        return GL_NEAREST_MIPMAP_NEAREST_;
    if (s == "linearMipNearest")
        return GL_LINEAR_MIPMAP_NEAREST_;
    if (s == "nearestMipLinear")
        return GL_NEAREST_MIPMAP_LINEAR_;
    if (s == "linearMipLinear")
        return GL_LINEAR_MIPMAP_LINEAR_;
    return GL_LINEAR_;
}

bool isMipFilter(uint32_t f) {
    return f >= GL_NEAREST_MIPMAP_NEAREST_ && f <= GL_LINEAR_MIPMAP_LINEAR_;
}

uint32_t wrap(const std::string &s) {
    if (s == "repeat")
        return GL_REPEAT_;
    if (s == "mirror")
        return GL_MIRRORED_REPEAT_;
    return GL_CLAMP_TO_EDGE_;
}

CullSide side(const std::string &s) {
    if (s == "back")
        return CullSide::Back;
    if (s == "double")
        return CullSide::Double;
    return CullSide::Front;
}

BlendMode blendMode(const std::string &s) {
    if (s == "none")
        return BlendMode::None;
    if (s == "additive")
        return BlendMode::Additive;
    if (s == "subtractive")
        return BlendMode::Subtractive;
    if (s == "multiply")
        return BlendMode::Multiply;
    if (s == "custom")
        return BlendMode::Custom;
    return BlendMode::Normal;
}

float srgbEncode(float c) {
    c = std::max(0.0f, c);
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 0.41666f) - 0.055f;
}

Vec4 v4(const std::array<float, 3> &a, float w = 0) { return {a[0], a[1], a[2], w}; }

void mat3Of(const std::array<float, 9> &a, float *out) {
    std::memcpy(out, a.data(), 9 * sizeof(float));
}

/** Inverse transpose of an affine matrix's 3x3 part (column-major out), and whether it mirrors. */
bool normalMatrix(const float *a, float *out) {
    float m00 = a[0], m10 = a[1], m20 = a[2], m01 = a[3], m11 = a[4], m21 = a[5], m02 = a[6],
          m12 = a[7], m22 = a[8];
    float c00 = m11 * m22 - m21 * m12, c01 = m20 * m12 - m10 * m22, c02 = m10 * m21 - m20 * m11;
    float det = m00 * c00 + m01 * c01 + m02 * c02;
    float k = det != 0 ? 1.0f / det : 0.0f;
    // (M^-1)^T = cofactor(M) / det
    out[0] = c00 * k;
    out[1] = c01 * k;
    out[2] = c02 * k;
    out[3] = (m21 * m02 - m01 * m22) * k;
    out[4] = (m00 * m22 - m20 * m02) * k;
    out[5] = (m20 * m01 - m00 * m21) * k;
    out[6] = (m01 * m12 - m11 * m02) * k;
    out[7] = (m10 * m02 - m00 * m12) * k;
    out[8] = (m00 * m11 - m10 * m01) * k;
    return det < 0;
}

template <class T> void put(std::vector<uint8_t> &out, size_t offset, const T &v) {
    std::memcpy(out.data() + offset, &v, sizeof(T));
}

} // namespace

// ---- Internal state
// ---------------------------------------------------------------------------------

struct SceneModel::Geo {
    uint32_t id = 0;
    uint32_t count = 0;
    std::vector<float> position, normal, uv, color; // color: 4 per vertex, linear
    bool hasNormal = false, hasUv = false, hasColor = false;
    bool indexed = false;
    std::vector<uint32_t> index;
    std::vector<std::array<int64_t, 3>> groups;
    int64_t rangeStart = 0, rangeCount = -1;
    Sphere sphere;
    uint64_t version = 0;
    std::shared_ptr<const GpuVertices> gpu;
    uint64_t gpuVersion = ~0ull;
    std::shared_ptr<const GpuIndices> gpuIndex;
    std::shared_ptr<const GpuIndices> gpuWire;
    uint64_t wireVersion = ~0ull;
    std::unordered_set<uint32_t> users;

    uint32_t elements() const { return indexed ? uint32_t(index.size()) : count; }
};

struct SceneModel::Mat {
    uint32_t id = 0;
    std::shared_ptr<const MaterialState> state;
    /** Every look field but the rgb color, for merging materials that differ only in color. */
    std::string look;
    /** Merges at all: opaque, or a transparent layer that looks the same in any order (vr/batch.ts
     * flatLayer). */
    bool mergeable = false;
    std::unordered_set<uint32_t> users;
};

enum class ObjKind : uint8_t { Mesh, Instanced, Sprite, Points, Lines, LineStrip, LineLoop };

struct SceneModel::Obj {
    uint32_t id = 0;
    ObjKind kind = ObjKind::Mesh;
    uint32_t geo = 0;
    std::vector<uint32_t> mats;
    bool matArray = false;
    int32_t groupOrder = 0, renderOrder = 0;
    bool cast = false, recv = false, cull = true, visible = true;
    float m[12] = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
    float center[2] = {0.5f, 0.5f};
    uint32_t instCount = 0;
    std::vector<float> instM, instC;
    Sphere instSphere;
    std::shared_ptr<const GpuInstances> gpuInst;
    /** Last time it moved or changed; it merges once it has held still for staticAfterSeconds. */
    double since = 0;
    /** How long it must hold still: doubles each time it is evicted from a batch (up to a cap). */
    double settle = 0;
    std::vector<uint32_t>
        batches; // the batches its pieces are merged into (empty: drawn on its own)
};

struct SceneModel::Batch {
    struct Member {
        uint32_t obj;
        uint32_t first, count; // index range in the batch
        bool active = true;
    };
    uint32_t id = 0;
    std::string key;  // look + place
    std::string look; // the Mat::look every piece in it has
    std::vector<Member> members;
    uint32_t vertices = 0;
    std::shared_ptr<const GpuVertices> gpu;
    std::shared_ptr<const GpuIndices> gpuIndex;
    std::shared_ptr<const MaterialState> material;
    bool cast = false, recv = false;
    int32_t groupOrder = 0, renderOrder = 0;
    Sphere sphere;
    double holeSince =
        -1; // when the first member left (a rebuild follows rebuildDelaySeconds later)
};

// ---- Lifecycle
// ----------------------------------------------------------------------------------------

SceneModel::SceneModel(const ModelOptions &options) : options_(options), blobs_(options_.limits) {}
SceneModel::~SceneModel() = default;

void SceneModel::clear(std::vector<TextureOp> &ops) {
    geos_.clear();
    mats_.clear();
    objs_.clear();
    batches_.clear();
    batchByKey_.clear();
    textures_.clear();
    blobs_.clear();
    frame_ = FrameBlock{};
    sky_ = SkyBlock{};
    skyOn_ = false;
    fog_ = FogMode::None;
    hasBackground_ = false;
    shadow_ = false;
    shadowMapSize_ = 0;
    hasCamera_ = false;
    unsupported_ = 0;
    TextureOp op;
    op.kind = TextureOp::Clear;
    ops.push_back(std::move(op));
}

ApplyResult SceneModel::apply(const json &p, double now) {
    ApplyResult result;
    if (!p.is_object())
        throw PacketError("packet is not an object");
    if (num(p, "v") != 1)
        throw PacketError("packet version is not 1");
    uint64_t seq = u32(p, "seq");
    bool reset = flag(p, "reset", false);
    if (reset) {
        clear(result.textures);
        needsReset_ = false;
        uncommitted_ = false;
    } else if (needsReset_) {
        throw PacketError("waiting for a reset packet");
    } else if (seq != seq_ + 1) {
        needsReset_ = true;
        throw PacketError("packet seq " + std::to_string(seq) + " after " + std::to_string(seq_));
    }
    seq_ = seq;
    try {
        if (auto it = p.find("blobs"); it != p.end())
            for (const auto &b : *it)
                blobs_.add(b);
        if (auto it = p.find("textures"); it != p.end())
            for (const auto &t : *it)
                applyTexture(t, result.textures);
        if (auto it = p.find("geometries"); it != p.end())
            for (const auto &g : *it)
                applyGeometry(g, now);
        if (auto it = p.find("materials"); it != p.end())
            for (const auto &m : *it)
                applyMaterial(m, now);
        if (auto it = p.find("objects"); it != p.end())
            for (const auto &o : *it)
                applyObject(o, now);
        if (auto it = p.find("instances"); it != p.end())
            for (const auto &i : *it) {
                auto obj = objs_.find(u32(i, "id"));
                if (obj == objs_.end() || obj->second->kind != ObjKind::Instanced)
                    throw PacketError("instances for an unknown instanced object");
                applyInstances(*obj->second, field(i, "inst"));
                dirty_ = true;
            }
        if (auto it = p.find("xf"); it != p.end())
            applyTransforms(*it, now);
        if (auto it = p.find("show"); it != p.end())
            applyVisibility(*it, true);
        if (auto it = p.find("hide"); it != p.end())
            applyVisibility(*it, false);
        if (auto it = p.find("env"); it != p.end())
            applyEnv(*it);
        if (auto it = p.find("camera"); it != p.end())
            applyCamera(*it);
        if (auto it = p.find("remove"); it != p.end())
            remove(*it, result.textures);
        if (auto it = p.find("unsupported"); it != p.end() && it->is_array())
            unsupported_ += uint32_t(it->size());
    } catch (...) {
        needsReset_ = true;
        throw;
    }
    bool commit = flag(p, "commit", false);
    uncommitted_ = !commit;
    if (commit) {
        commits_++;
        updateBatches(now);
        result.committed = true;
        result.state = build();
    }
    return result;
}

ApplyResult SceneModel::tick(double now) {
    ApplyResult result;
    if (uncommitted_ || needsReset_ || now - lastBatchCheck_ < 0.25)
        return result;
    updateBatches(now);
    if (dirty_)
        result.state = build();
    return result;
}

// ---- Items
// ------------------------------------------------------------------------------------------

void SceneModel::applyTexture(const json &t, std::vector<TextureOp> &ops) {
    TextureOp op;
    op.id = u32(t, "id");
    op.rev = uint32_t(num(t, "rev", 0));
    op.wrapS = wrap(str(t, "wrapS", "clamp"));
    op.wrapT = wrap(str(t, "wrapT", "clamp"));
    op.mag = filter(str(t, "mag", "linear"));
    if (op.mag != GL_NEAREST_)
        op.mag = GL_LINEAR_;
    op.min = filter(str(t, "min", "linear"));
    op.mips = flag(t, "mips", false);
    if (!op.mips && isMipFilter(op.min))
        op.min = (op.min == GL_NEAREST_MIPMAP_NEAREST_ || op.min == GL_NEAREST_MIPMAP_LINEAR_)
                     ? GL_NEAREST_
                     : GL_LINEAR_;
    op.srgb = flag(t, "srgb", false);
    op.aniso = float(num(t, "aniso", 1));
    auto data = t.find("data");
    if (data != t.end() && !data->is_null()) {
        std::vector<uint8_t> bytes = blobs_.take(*data);
        op.image =
            decodeImage(str(t, "fmt", ""), bytes, int(num(t, "w")), int(num(t, "h")),
                        flag(t, "flipY", false), flag(t, "premultiply", false), options_.limits);
        op.kind = TextureOp::Upload;
    } else {
        if (!textures_.count(op.id))
            return; // sampler of pixels not sent yet: the upload carries it
        op.kind = TextureOp::Sampler;
    }
    textures_.insert(op.id);
    ops.push_back(std::move(op));
}

void SceneModel::applyGeometry(const json &g, double now) {
    uint32_t id = u32(g, "id");
    auto &slot = geos_[id];
    bool partial = flag(g, "partial", false);
    if (partial && !slot)
        throw PacketError("partial update of unknown geometry " + std::to_string(id));
    if (!slot) {
        slot = std::make_unique<Geo>();
        slot->id = id;
    }
    Geo &geo = *slot;
    uint32_t count = u32(g, "count");
    if (count > options_.limits.maxVertices)
        throw PacketError("geometry " + std::to_string(id) + " has too many vertices");
    if (partial && count != geo.count)
        throw PacketError("partial update changes the vertex count");
    geo.count = count;
    const json &attrs = field(g, "attrs");
    auto attr = [&](const char *name, size_t width, std::vector<float> &out, bool &has) {
        auto it = attrs.find(name);
        if (it == attrs.end()) {
            if (!partial) {
                out.clear();
                has = false;
            }
            return;
        }
        uint32_t n = u32(*it, "n");
        std::vector<float> raw = asFloats(blobs_.take(field(*it, "data")), size_t(count) * n, name);
        if (width == 4 && n == 3) {
            out.resize(size_t(count) * 4);
            for (size_t i = 0; i < count; i++) {
                out[i * 4] = raw[i * 3];
                out[i * 4 + 1] = raw[i * 3 + 1];
                out[i * 4 + 2] = raw[i * 3 + 2];
                out[i * 4 + 3] = 1;
            }
        } else if (n == width) {
            out = std::move(raw);
        } else {
            throw PacketError(std::string("attribute ") + name + " has " + std::to_string(n) +
                              " components");
        }
        has = true;
    };
    bool hasPosition = !geo.position.empty() || count == 0;
    attr("position", 3, geo.position, hasPosition);
    if (!hasPosition && count)
        throw PacketError("geometry " + std::to_string(id) + " has no positions");
    attr("normal", 3, geo.normal, geo.hasNormal);
    attr("uv", 2, geo.uv, geo.hasUv);
    attr("color", 4, geo.color, geo.hasColor);
    if (!partial) {
        auto idx = g.find("index");
        if (idx != g.end() && !idx->is_null()) {
            uint32_t n = u32(*idx, "count");
            std::string type = str(*idx, "t", "u16");
            std::vector<uint8_t> bytes = blobs_.take(field(*idx, "data"));
            size_t width = type == "u32" ? 4 : 2;
            if (bytes.size() != size_t(n) * width)
                throw PacketError("index has the wrong size");
            geo.index.resize(n);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t v = 0;
                if (width == 4)
                    std::memcpy(&v, bytes.data() + size_t(i) * 4, 4);
                else {
                    uint16_t s;
                    std::memcpy(&s, bytes.data() + size_t(i) * 2, 2);
                    v = s;
                }
                if (v >= count)
                    throw PacketError("index " + std::to_string(v) + " out of range in geometry " +
                                      std::to_string(id));
                geo.index[i] = v;
            }
            geo.indexed = true;
        } else {
            geo.index.clear();
            geo.indexed = false;
        }
        geo.groups.clear();
        if (auto gr = g.find("groups"); gr != g.end())
            for (const auto &v : *gr) {
                if (!v.is_array() || v.size() != 3)
                    throw PacketError("bad geometry group");
                geo.groups.push_back(
                    {v[0].get<int64_t>(), v[1].get<int64_t>(), v[2].get<int64_t>()});
            }
        auto range = vecN<2>(g, "range", {0, -1});
        geo.rangeStart = int64_t(range[0]);
        geo.rangeCount = int64_t(range[1]);
        geo.gpuIndex.reset();
    }
    auto s = vecN<4>(g, "sphere", {0, 0, 0, -1});
    geo.sphere = {{s[0], s[1], s[2]}, s[3]};
    geo.version++;
    for (uint32_t user : geo.users)
        if (auto it = objs_.find(user); it != objs_.end())
            unsettle(*it->second, now);
    dirty_ = true;
}

void SceneModel::applyMaterial(const json &j, double now) {
    uint32_t id = u32(j, "id");
    auto state = std::make_shared<MaterialState>();
    MaterialState &m = *state;
    m.id = id;
    m.version = nextSerial();
    std::string type = str(j, "type", "basic");
    m.lit = type == "toon" || type == "lambert" || type == "phong" || type == "standard";
    if (type == "toon")
        m.model = ShadeModel::Toon;
    else if (type == "lambert")
        m.model = ShadeModel::Lambert;
    else if (type == "phong")
        m.model = ShadeModel::Phong;
    else if (type == "standard")
        m.model = ShadeModel::Standard;
    else if (type == "points")
        m.model = ShadeModel::Points;
    else if (type == "line")
        m.model = ShadeModel::Line;
    else if (type == "sprite")
        m.model = ShadeModel::Sprite;
    else if (type == "shader") {
        std::string program = "unknown";
        const json *uniforms = nullptr;
        if (auto sh = j.find("shader"); sh != j.end()) {
            program = str(*sh, "program", "unknown");
            if (auto u = sh->find("uniforms"); u != sh->end())
                uniforms = &*u;
        }
        auto uvec = [&](const char *key) {
            return uniforms ? vecN<3>(*uniforms, key, {0, 0, 0}) : std::array<float, 3>{0, 0, 0};
        };
        auto unum = [&](const char *key) {
            return uniforms ? float(num(*uniforms, key, 0)) : 0.0f;
        };
        if (program == "beam") {
            m.model = ShadeModel::Beam;
            auto c = uvec("color");
            m.color[0] = c[0];
            m.color[1] = c[1];
            m.color[2] = c[2];
            m.color[3] = unum("opacity");
        } else if (program == "skyDome") {
            m.model = ShadeModel::SkyDome;
            const char *keys[] = {"top", "horizon", "glow", "moonDir", "moonGlow"};
            for (int i = 0; i < 5; i++) {
                auto v = uvec(keys[i]);
                std::copy(v.begin(), v.end(), m.skyUniforms[i]);
            }
            m.skyUniforms[2][3] = unum("glowK");
            m.color[3] = unum("opacity");
        } else {
            m.drawable = false;
        }
    } else
        m.model = ShadeModel::Basic;
    if (m.model != ShadeModel::Beam && m.model != ShadeModel::SkyDome) {
        auto c = vecN<3>(j, "color", {1, 1, 1});
        m.color[0] = c[0];
        m.color[1] = c[1];
        m.color[2] = c[2];
        m.color[3] = float(num(j, "opacity", 1));
    }
    auto e = vecN<3>(j, "emissive", {0, 0, 0});
    std::copy(e.begin(), e.end(), m.emissive);
    m.visible = flag(j, "visible", true);
    m.transparent = flag(j, "transparent", false);
    m.alphaTest = float(num(j, "alphaTest", 0));
    m.side = side(str(j, "side", "front"));
    m.shadowSide = side(str(j, "shadowSide", "back"));
    m.depthTest = flag(j, "depthTest", true);
    m.depthWrite = flag(j, "depthWrite", true);
    m.colorWrite = flag(j, "colorWrite", true);
    m.depthFunc = depthFunc(str(j, "depthFunc", "lequal"));
    if (auto b = j.find("blend"); b != j.end()) {
        if (!b->is_array() || b->size() != 8)
            throw PacketError("bad blend");
        m.blend.mode = blendMode((*b)[0].get<std::string>());
        m.blend.premultiplied = (*b)[1].get<bool>();
        m.blend.eq = equation((*b)[2].get<std::string>());
        m.blend.src = factor((*b)[3].get<std::string>());
        m.blend.dst = factor((*b)[4].get<std::string>());
        m.blend.eqAlpha = equation((*b)[5].get<std::string>());
        m.blend.srcAlpha = factor((*b)[6].get<std::string>());
        m.blend.dstAlpha = factor((*b)[7].get<std::string>());
    }
    m.premultipliedAlpha = m.blend.premultiplied;
    if (auto po = j.find("polygonOffset"); po != j.end() && po->is_array() && po->size() == 2) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = (*po)[0].get<float>();
        m.polygonOffsetUnits = (*po)[1].get<float>();
    }
    m.wireframe = flag(j, "wireframe", false);
    m.forceSinglePass = flag(j, "forceSinglePass", false);
    m.vertexColors = flag(j, "vertexColors", false);
    m.fog = flag(j, "fog", false);
    m.sky = flag(j, "sky", false);
    m.flatShading = flag(j, "flatShading", false);
    m.sizeAttenuation = flag(j, "sizeAttenuation", true);
    m.pointSize = float(num(j, "size", 1));
    m.rotation = float(num(j, "rotation", 0));
    m.metalness = float(num(j, "metalness", 0));
    m.roughness = float(num(j, "roughness", 1));
    auto sp = vecN<3>(j, "specular", {0.067f, 0.067f, 0.067f});
    std::copy(sp.begin(), sp.end(), m.specular);
    m.specular[3] = float(num(j, "shininess", 30));
    m.sharpText = flag(j, "sharpText", false);
    auto mapRef = [&](const char *key, uint32_t &tex, float *transform) {
        auto it = j.find(key);
        if (it == j.end() || it->is_null())
            return;
        tex = u32(*it, "t");
        mat3Of(vecN<9>(*it, "m", {1, 0, 0, 0, 1, 0, 0, 0, 1}), transform);
    };
    float unused[9];
    mapRef("map", m.map, m.mapTransform);
    mapRef("alphaMap", m.alphaMap, m.alphaMapTransform);
    mapRef("emissiveMap", m.emissiveMap, m.emissiveMapTransform);
    mapRef("gradientMap", m.gradientMap, unused);

    auto &slot = mats_[id];
    if (!slot) {
        slot = std::make_unique<Mat>();
        slot->id = id;
    }
    slot->state = state;
    // The look: everything a merged draw shares. Color is baked per vertex instead.
    char buf[512];
    std::snprintf(buf, sizeof buf,
                  "%d|%d%d%d%d|%.5g|%.5g|%u,%u,%u,%u|%d%d|%d%d%d%u|%d%d%u%u%u%u%u%u|%d%.4g,%.4g|%d%"
                  "d%d%d%d%d|%.4g,%.4g,%.4g",
                  int(m.model), m.lit, m.drawable, m.transparent, m.vertexColors, m.color[3],
                  m.alphaTest, m.map, m.alphaMap, m.emissiveMap, m.gradientMap, int(m.side),
                  int(m.shadowSide), m.depthTest, m.depthWrite, m.colorWrite, m.depthFunc,
                  int(m.blend.mode), m.blend.premultiplied, m.blend.eq, m.blend.src, m.blend.dst,
                  m.blend.eqAlpha, m.blend.srcAlpha, m.blend.dstAlpha, m.polygonOffset,
                  m.polygonOffsetFactor, m.polygonOffsetUnits, m.fog, m.sky, m.flatShading,
                  m.wireframe, m.forceSinglePass, m.visible, m.emissive[0], m.emissive[1],
                  m.emissive[2]);
    std::string look = buf;
    auto transform = [&](const float *t) {
        std::string s;
        for (int i = 0; i < 9; i++)
            s += std::to_string(t[i]) + ",";
        return s;
    };
    if (m.map)
        look += "|m" + transform(m.mapTransform);
    if (m.alphaMap)
        look += "|a" + transform(m.alphaMapTransform);
    if (m.emissiveMap)
        look += "|e" + transform(m.emissiveMapTransform);
    if (m.sharpText)
        look += "|sharp";
    slot->look = look;
    bool flatLayer = m.transparent && !m.depthWrite && !m.vertexColors && !m.map && !m.alphaMap &&
                     (m.blend.mode == BlendMode::Normal || m.blend.mode == BlendMode::Additive);
    bool meshModel = m.model == ShadeModel::Basic || m.model == ShadeModel::Toon ||
                     m.model == ShadeModel::Lambert || m.model == ShadeModel::Phong ||
                     m.model == ShadeModel::Standard;
    slot->mergeable = m.drawable && meshModel && !m.wireframe && (!m.transparent || flatLayer);
    for (uint32_t user : slot->users)
        if (auto it = objs_.find(user); it != objs_.end())
            unsettle(*it->second, now);
    dirty_ = true;
}

void SceneModel::applyObject(const json &j, double now) {
    uint32_t id = u32(j, "id");
    auto &slot = objs_[id];
    if (!slot) {
        if (objs_.size() > options_.limits.maxObjects)
            throw PacketError("too many objects");
        slot = std::make_unique<Obj>();
        slot->id = id;
        slot->settle = options_.staticAfterSeconds;
    } else {
        evict(*slot);
        if (auto g = geos_.find(slot->geo); g != geos_.end())
            g->second->users.erase(id);
        for (uint32_t m : slot->mats)
            if (auto it = mats_.find(m); it != mats_.end())
                it->second->users.erase(id);
    }
    Obj &o = *slot;
    std::string kind = str(j, "kind", "mesh");
    if (kind == "mesh")
        o.kind = ObjKind::Mesh;
    else if (kind == "instanced")
        o.kind = ObjKind::Instanced;
    else if (kind == "sprite")
        o.kind = ObjKind::Sprite;
    else if (kind == "points")
        o.kind = ObjKind::Points;
    else if (kind == "lines")
        o.kind = ObjKind::Lines;
    else if (kind == "lineStrip")
        o.kind = ObjKind::LineStrip;
    else if (kind == "lineLoop")
        o.kind = ObjKind::LineLoop;
    else
        throw PacketError("unknown object kind \"" + kind + "\"");
    o.geo = u32(j, "geo");
    const json &mat = field(j, "mat");
    o.mats.clear();
    o.matArray = mat.is_array();
    if (o.matArray)
        for (const auto &m : mat)
            o.mats.push_back(m.get<uint32_t>());
    else
        o.mats.push_back(mat.get<uint32_t>());
    auto order = vecN<2>(j, "order", {0, 0});
    o.groupOrder = int32_t(order[0]);
    o.renderOrder = int32_t(order[1]);
    o.cast = flag(j, "cast", false);
    o.recv = flag(j, "recv", false);
    o.cull = flag(j, "cull", true);
    o.visible = flag(j, "visible", true);
    auto m = vecN<12>(j, "m", {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0});
    std::copy(m.begin(), m.end(), o.m);
    auto c = vecN<2>(j, "center", {0.5f, 0.5f});
    o.center[0] = c[0];
    o.center[1] = c[1];
    if (o.kind == ObjKind::Instanced)
        applyInstances(o, field(j, "inst"));
    if (auto g = geos_.find(o.geo); g != geos_.end())
        g->second->users.insert(id);
    for (uint32_t mid : o.mats)
        if (auto it = mats_.find(mid); it != mats_.end())
            it->second->users.insert(id);
    o.since = now;
    dirty_ = true;
}

void SceneModel::applyInstances(Obj &o, const json &inst) {
    uint32_t count = u32(inst, "count");
    if (count > options_.limits.maxInstances)
        throw PacketError("too many instances");
    o.instCount = count;
    o.instM = asFloats(blobs_.take(field(inst, "m")), size_t(count) * 12, "instance matrices");
    if (auto c = inst.find("c"); c != inst.end() && !c->is_null())
        o.instC = asFloats(blobs_.take(*c), size_t(count) * 3, "instance colors");
    else
        o.instC.clear();
    auto s = vecN<4>(inst, "sphere", {0, 0, 0, -1});
    o.instSphere = {{s[0], s[1], s[2]}, s[3]};
    auto gpu = std::make_shared<GpuInstances>();
    gpu->serial = nextSerial();
    gpu->count = count;
    gpu->color = !o.instC.empty();
    gpu->bytes.resize(size_t(count) * kInstanceStride);
    for (uint32_t i = 0; i < count; i++) {
        const float *a = &o.instM[size_t(i) * 12];
        // Rows of the 3x4 matrix, from its columns (a[0..2] column 0 ... a[9..11] column 3).
        float rows[12] = {a[0], a[3], a[6], a[9], a[1], a[4], a[7], a[10], a[2], a[5], a[8], a[11]};
        std::memcpy(gpu->bytes.data() + size_t(i) * kInstanceStride, rows, sizeof rows);
        float col[3] = {1, 1, 1};
        if (gpu->color)
            std::memcpy(col, &o.instC[size_t(i) * 3], sizeof col);
        std::memcpy(gpu->bytes.data() + size_t(i) * kInstanceStride + 48, col, sizeof col);
    }
    o.gpuInst = gpu;
}

void SceneModel::applyTransforms(const json &xf, double now) {
    std::vector<uint32_t> ids = idList(xf, "ids", options_.limits.maxObjects);
    std::vector<float> m = asFloats(blobs_.take(field(xf, "m")), ids.size() * 12, "transforms");
    for (size_t i = 0; i < ids.size(); i++) {
        auto it = objs_.find(ids[i]);
        if (it == objs_.end())
            continue;
        std::memcpy(it->second->m, &m[i * 12], 12 * sizeof(float));
        unsettle(*it->second, now);
    }
    dirty_ = true;
}

void SceneModel::applyVisibility(const json &ids, bool visible) {
    if (!ids.is_array())
        throw PacketError("show/hide is not an array");
    for (const auto &v : ids) {
        auto it = objs_.find(v.get<uint32_t>());
        if (it == objs_.end())
            continue;
        Obj &o = *it->second;
        if (o.visible == visible)
            continue;
        o.visible = visible;
        // Merged pieces only ever draw visible objects; hiding one takes it out, showing it waits
        // again.
        if (!visible)
            evict(o);
    }
    dirty_ = true;
}

void SceneModel::applyEnv(const json &env) {
    FrameBlock f;
    auto bg = env.find("background");
    hasBackground_ = bg != env.end() && bg->is_array();
    if (hasBackground_) {
        auto c = vecN<3>(env, "background", {0, 0, 0});
        std::copy(c.begin(), c.end(), background_);
    }
    fog_ = FogMode::None;
    if (auto fog = env.find("fog"); fog != env.end() && fog->is_object()) {
        auto c = vecN<3>(*fog, "color", {0, 0, 0});
        f.fogColor = {srgbEncode(c[0]), srgbEncode(c[1]), srgbEncode(c[2]), 0};
        if (fog->contains("density")) {
            fog_ = FogMode::Exp2;
            f.fogColor.w = 2;
            f.fogParams.z = float(num(*fog, "density"));
        } else {
            fog_ = FogMode::Linear;
            f.fogColor.w = 1;
            f.fogParams.x = float(num(*fog, "near"));
            f.fogParams.y = float(num(*fog, "far"));
        }
    }
    f.ambient = v4(vecN<3>(env, "ambient", {0, 0, 0}));
    int hemi = 0, dir = 0, point = 0;
    if (auto h = env.find("hemi"); h != env.end())
        for (const auto &l : *h) {
            if (hemi >= kMaxHemi)
                break;
            f.hemiSky[hemi] = v4(vecN<3>(l, "sky", {0, 0, 0}));
            f.hemiGround[hemi] = v4(vecN<3>(l, "ground", {0, 0, 0}));
            f.hemiDir[hemi] = v4(vecN<3>(l, "dir", {0, 1, 0}));
            hemi++;
        }
    shadow_ = false;
    f.counts.w = -1;
    if (auto d = env.find("dir"); d != env.end())
        for (const auto &l : *d) {
            if (dir >= kMaxDir)
                break;
            f.dirColor[dir] = v4(vecN<3>(l, "color", {0, 0, 0}));
            f.dirDir[dir] = v4(vecN<3>(l, "dir", {0, 1, 0}));
            auto sh = l.find("shadow");
            if (options_.shadows && !shadow_ && sh != l.end() && sh->is_object()) {
                shadow_ = true;
                f.counts.w = dir;
                auto vp = vecN<16>(*sh, "viewProj", {});
                std::copy(vp.begin(), vp.end(), lightViewProj_);
                auto sm = vecN<16>(*sh, "matrix", {});
                std::copy(sm.begin(), sm.end(), f.shadowMatrix.m);
                f.shadowParams = {float(num(*sh, "bias", 0)), float(num(*sh, "normalBias", 0)),
                                  float(num(*sh, "radius", 1)), float(num(*sh, "intensity", 1))};
                auto size = vecN<2>(*sh, "mapSize", {512, 512});
                int s = std::max(64, std::min(4096, int(size[0])));
                shadowMapSize_ = s;
                f.shadowMapSize = {float(s), float(s), 1.0f / s, 1.0f / s};
            }
            dir++;
        }
    if (auto pt = env.find("point"); pt != env.end())
        for (const auto &l : *pt) {
            auto c = vecN<3>(l, "color", {0, 0, 0});
            // A light at zero intensity lights nothing; three still loops over it, the shaders need
            // not.
            if (c[0] == 0 && c[1] == 0 && c[2] == 0)
                continue;
            if (point >= kMaxPoint)
                break;
            f.pointPos[point] = v4(vecN<3>(l, "pos", {0, 0, 0}), float(num(l, "distance", 0)));
            f.pointColor[point] = v4(c, float(num(l, "decay", 2)));
            point++;
        }
    f.counts.x = hemi;
    f.counts.y = dir;
    f.counts.z = point;
    frame_ = f;

    SkyBlock s;
    auto sky = env.find("sky");
    skyOn_ = sky != env.end() && sky->is_object();
    if (skyOn_) {
        const json &k = *sky;
        s.flags = {float(num(k, "on", 1)), float(num(k, "inside", 1)), float(num(k, "wet", 0)),
                   float(num(k, "snow", 0))};
        s.misc = {float(num(k, "drop", 0)), float(num(k, "street", 0)),
                  float(num(k, "hazeClear", 6)), float(num(k, "hazeAbove", 17.5))};
        s.haze = {float(num(k, "hazeMax", 300)), 1, 0, 0};
        s.office = v4(vecN<3>(k, "office", {0, 0, 0}));
        s.garage = v4(vecN<3>(k, "garage", {0, 0, 0}));
        s.officeMin = v4(vecN<3>(k, "officeMin", {0, 0, 0}));
        s.officeMax = v4(vecN<3>(k, "officeMax", {0, 0, 0}));
        auto gb = vecN<6>(k, "garageBox", {0, 0, 0, 0, 0, 0});
        s.garageBox = {gb[0], gb[1], gb[2], gb[3]};
        s.garageY = {gb[4], gb[5], 0, 0};
        int lamps = std::max(0, std::min(kMaxLamps, int(num(k, "lampCount", 0))));
        int screens = std::max(0, std::min(kMaxScreens, int(num(k, "screenCount", 0))));
        s.counts = {lamps, screens, 0, 0};
        s.lampMin = v4(vecN<3>(k, "lampMin", {0, 0, 0}));
        s.lampMax = v4(vecN<3>(k, "lampMax", {0, 0, 0}));
        s.screenMin = v4(vecN<3>(k, "screenMin", {0, 0, 0}));
        s.screenMax = v4(vecN<3>(k, "screenMax", {0, 0, 0}));
        auto fill4 = [&](const char *key, Vec4 *out, int n, int width) {
            std::vector<float> v =
                floatList(k, key, size_t(kMaxScreens > kMaxLamps ? kMaxScreens : kMaxLamps) * 4);
            if (v.size() < size_t(n) * width)
                throw PacketError(std::string("sky ") + key + " is short");
            for (int i = 0; i < n; i++)
                out[i] = {v[i * width], v[i * width + 1], v[i * width + 2],
                          width == 4 ? v[i * width + 3] : 0.0f};
        };
        fill4("lamps", s.lamps, lamps, 4);
        fill4("lampColors", s.lampColors, lamps, 3);
        fill4("screens", s.screens, screens, 4);
        fill4("screenDirs", s.screenDirs, screens, 3);
        fill4("screenColors", s.screenColors, screens, 3);
    }
    sky_ = s;
    dirty_ = true;
}

void SceneModel::applyCamera(const json &c) {
    auto m = vecN<12>(c, "m", {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0});
    Mat4 full = fromAffine(m.data());
    std::copy(full.begin(), full.end(), camera_);
    hasCamera_ = true;
}

void SceneModel::removeObject(uint32_t id) {
    auto it = objs_.find(id);
    if (it == objs_.end())
        return;
    Obj &o = *it->second;
    evict(o);
    if (auto g = geos_.find(o.geo); g != geos_.end())
        g->second->users.erase(id);
    for (uint32_t m : o.mats)
        if (auto mt = mats_.find(m); mt != mats_.end())
            mt->second->users.erase(id);
    objs_.erase(it);
}

void SceneModel::remove(const json &r, std::vector<TextureOp> &ops) {
    for (uint32_t id : idList(r, "objects", 1u << 20))
        removeObject(id);
    for (uint32_t id : idList(r, "geometries", 1u << 20))
        geos_.erase(id);
    for (uint32_t id : idList(r, "materials", 1u << 20))
        mats_.erase(id);
    for (uint32_t id : idList(r, "textures", 1u << 20)) {
        if (!textures_.erase(id))
            continue;
        TextureOp op;
        op.kind = TextureOp::Remove;
        op.id = id;
        ops.push_back(std::move(op));
    }
    dirty_ = true;
}

// ---- Static batching
// ------------------------------------------------------------------------------

void SceneModel::unsettle(Obj &o, double now) {
    if (!o.batches.empty()) {
        evict(o);
        // Something that moved once it was merged may move again: it waits twice as long next time.
        o.settle = std::min(double(options_.maxStaticAfterSeconds), o.settle * 2);
    }
    o.since = now;
}

void SceneModel::evict(Obj &o) {
    for (uint32_t bid : o.batches) {
        auto it = batches_.find(bid);
        if (it == batches_.end())
            continue;
        Batch &b = *it->second;
        for (auto &mem : b.members)
            if (mem.obj == o.id && mem.active) {
                mem.active = false;
                if (b.holeSince < 0)
                    b.holeSince = lastBatchCheck_;
            }
    }
    o.batches.clear();
    dirty_ = true;
}

bool SceneModel::eligible(const Obj &o, double now) const {
    if (o.kind != ObjKind::Mesh || !o.visible || !o.batches.empty())
        return false;
    if (now - o.since < o.settle)
        return false;
    auto g = geos_.find(o.geo);
    if (g == geos_.end() || g->second->count == 0 || g->second->count > options_.maxBatchVertices)
        return false;
    for (uint32_t mid : o.mats) {
        auto m = mats_.find(mid);
        if (m == mats_.end() || !m->second->mergeable || !m->second->state->visible)
            return false;
    }
    return true;
}

std::string SceneModel::placeKey(const Obj &o) const {
    const Geo &g = *geos_.at(o.geo);
    Sphere s = transformSphere(o.m, g.sphere);
    float cell = options_.cellSize;
    char buf[96];
    std::snprintf(buf, sizeof buf, "|%d,%d,%d|%d%d|%d,%d|%d%d%d", int(std::floor(s.c.x / cell)),
                  int(std::floor(s.c.y / cell)), int(std::floor(s.c.z / cell)), o.cast, o.recv,
                  o.groupOrder, o.renderOrder, g.hasNormal, g.hasUv, 0);
    return buf;
}

namespace {

/** One piece of an object: the whole geometry, or one group of a multi-material mesh. */
struct PieceRange {
    uint32_t material;
    int64_t start, count;
};

/** three's draw range for a group (or the whole geometry), clipped to geometry.drawRange. */
bool clipRange(int64_t total, int64_t rangeStart, int64_t rangeCount, int64_t gStart,
               int64_t gCount, int64_t &start, int64_t &count) {
    int64_t rangeEnd = rangeCount < 0 ? total : std::min(total, rangeStart + rangeCount);
    int64_t groupEnd = gCount < 0 ? total : gStart + gCount;
    start = std::max(rangeStart, gStart);
    int64_t end = std::min(rangeEnd, groupEnd);
    count = end - start;
    return count > 0;
}

} // namespace

bool sharpScreenMaterial(const MaterialState &m) {
    return m.sharpText && m.drawable && m.visible && m.model == ShadeModel::Basic &&
           !m.transparent && m.map != 0 && !m.wireframe && m.colorWrite &&
           m.blend.mode == BlendMode::Normal;
}

bool sharpOverlayMaterial(const MaterialState &m) {
    bool model = m.model == ShadeModel::Basic || m.model == ShadeModel::Toon ||
                 m.model == ShadeModel::Lambert || m.model == ShadeModel::Phong ||
                 m.model == ShadeModel::Standard || m.model == ShadeModel::Sprite;
    return model && m.drawable && m.visible && m.transparent && !m.depthWrite && m.colorWrite &&
           !m.wireframe && m.depthTest &&
           (m.blend.mode == BlendMode::Normal || m.blend.mode == BlendMode::Additive);
}

void SceneModel::updateBatches(double now) {
    lastBatchCheck_ = now;
    // 1. Batches with holes older than the rebuild delay: rebuild with the members still in.
    std::vector<uint32_t> stale;
    for (auto &[id, b] : batches_)
        if (b->holeSince >= 0 && now - b->holeSince >= options_.rebuildDelaySeconds)
            stale.push_back(id);
    for (uint32_t id : stale) {
        Batch &b = *batches_.at(id);
        std::vector<uint32_t> keep;
        for (const auto &mem : b.members)
            if (mem.active && (keep.empty() || keep.back() != mem.obj))
                keep.push_back(mem.obj);
        for (uint32_t obj : keep)
            if (auto it = objs_.find(obj); it != objs_.end()) {
                auto &list = it->second->batches;
                list.erase(std::remove(list.begin(), list.end(), id), list.end());
            }
        rebuild(b, keep, now);
    }
    // 2. Objects that have held still: merge them in. All pieces of an object join in this one
    // pass.
    struct Join {
        std::string look;
        std::vector<uint32_t> objs;
    };
    std::unordered_map<std::string, Join> joins; // look + place -> objects joining
    std::vector<uint32_t> ready;
    for (auto &[id, o] : objs_)
        if (eligible(*o, now))
            ready.push_back(id);
    // In id order, so batches come out the same whatever the hash map's order.
    std::sort(ready.begin(), ready.end());
    for (uint32_t id : ready) {
        const Obj &o = *objs_.at(id);
        std::string place = placeKey(o);
        for (uint32_t mid : o.mats) {
            const Mat &m = *mats_.at(mid);
            Join &j = joins[m.look + place];
            j.look = m.look;
            if (j.objs.empty() || j.objs.back() != id)
                j.objs.push_back(id);
        }
    }
    if (joins.empty())
        return;
    std::unordered_map<uint32_t, std::vector<uint32_t>> grow; // batch -> objects joining
    for (auto &[key, join] : joins) {
        auto &ids = batchByKey_[key];
        // Fill the last batch of this key first, then open new ones.
        uint32_t target = ids.empty() ? 0 : ids.back();
        uint32_t used = target ? batches_.at(target)->vertices : 0;
        for (uint32_t obj : join.objs) {
            uint32_t n = geos_.at(objs_.at(obj)->geo)->count;
            if (!target || used + n > options_.maxBatchVertices) {
                auto b = std::make_unique<Batch>();
                b->id = nextBatch_++;
                b->key = key;
                b->look = join.look;
                target = b->id;
                used = 0;
                ids.push_back(target);
                batches_[target] = std::move(b);
            }
            used += n;
            auto &g = grow[target];
            if (g.empty() || g.back() != obj)
                g.push_back(obj);
        }
    }
    for (auto &[bid, add] : grow) {
        Batch &b = *batches_.at(bid);
        std::vector<uint32_t> members;
        for (const auto &mem : b.members)
            if (mem.active && (members.empty() || members.back() != mem.obj))
                members.push_back(mem.obj);
        for (uint32_t obj : members)
            if (auto it = objs_.find(obj); it != objs_.end()) {
                auto &list = it->second->batches;
                list.erase(std::remove(list.begin(), list.end(), bid), list.end());
            }
        members.insert(members.end(), add.begin(), add.end());
        rebuild(b, members, now);
    }
}

void SceneModel::dropBatch(uint32_t id) {
    auto it = batches_.find(id);
    if (it == batches_.end())
        return;
    auto &ids = batchByKey_[it->second->key];
    ids.erase(std::remove(ids.begin(), ids.end(), id), ids.end());
    if (ids.empty())
        batchByKey_.erase(it->second->key);
    batches_.erase(it);
}

void SceneModel::rebuild(Batch &b, std::vector<uint32_t> members, double) {
    dirty_ = true;
    b.members.clear();
    b.holeSince = -1;
    b.vertices = 0;
    b.sphere = {};
    b.material.reset();
    std::vector<uint8_t> vbytes;
    std::vector<uint32_t> indices;
    std::vector<int32_t> remap;
    bool anyNormal = false, anyUv = false;
    for (uint32_t oid : members) {
        auto oit = objs_.find(oid);
        if (oit == objs_.end())
            continue;
        Obj &o = *oit->second;
        auto git = geos_.find(o.geo);
        if (git == geos_.end())
            continue;
        const Geo &g = *git->second;
        // The pieces of this object whose material has this batch's look.
        std::vector<PieceRange> pieces;
        auto lookOf = [&](uint32_t mid) -> const Mat * {
            auto m = mats_.find(mid);
            return m == mats_.end() ? nullptr : m->second.get();
        };
        int64_t total = g.elements();
        if (o.matArray) {
            for (const auto &gr : g.groups) {
                if (gr[2] < 0 || size_t(gr[2]) >= o.mats.size())
                    continue;
                const Mat *m = lookOf(o.mats[size_t(gr[2])]);
                if (!m || m->look != b.look)
                    continue;
                int64_t s, c;
                if (clipRange(total, g.rangeStart, g.rangeCount, gr[0], gr[1], s, c))
                    pieces.push_back({m->id, s, c});
            }
        } else {
            const Mat *m = lookOf(o.mats[0]);
            int64_t s, c;
            if (m && m->look == b.look && clipRange(total, g.rangeStart, g.rangeCount, 0, -1, s, c))
                pieces.push_back({m->id, s, c});
        }
        if (pieces.empty())
            continue;
        float nm[9];
        bool mirrored = normalMatrix(o.m, nm);
        for (const PieceRange &piece : pieces) {
            const MaterialState &ms = *mats_.at(piece.material)->state;
            if (!b.material) {
                auto bm = std::make_shared<MaterialState>(ms);
                bm->color[0] = bm->color[1] = bm->color[2] = 1;
                bm->version = nextSerial();
                b.material = bm;
                b.cast = o.cast;
                b.recv = o.recv;
                b.groupOrder = o.groupOrder;
                b.renderOrder = o.renderOrder;
            }
            uint32_t firstIndex = uint32_t(indices.size());
            remap.assign(g.count, -1);
            auto emit = [&](uint32_t v) -> uint32_t {
                if (remap[v] >= 0)
                    return uint32_t(remap[v]);
                uint32_t out = b.vertices++;
                remap[v] = int32_t(out);
                size_t off = vbytes.size();
                vbytes.resize(off + kVertexStride);
                Vec3 p = transformPoint(
                    o.m, {g.position[v * 3], g.position[v * 3 + 1], g.position[v * 3 + 2]});
                float pos[3] = {p.x, p.y, p.z};
                std::memcpy(vbytes.data() + off, pos, 12);
                uint32_t n = 0;
                if (g.hasNormal) {
                    float x = g.normal[v * 3], y = g.normal[v * 3 + 1], z = g.normal[v * 3 + 2];
                    float wx = nm[0] * x + nm[3] * y + nm[6] * z,
                          wy = nm[1] * x + nm[4] * y + nm[7] * z,
                          wz = nm[2] * x + nm[5] * y + nm[8] * z;
                    float len = std::sqrt(wx * wx + wy * wy + wz * wz);
                    if (len > 0)
                        n = packNormal(wx / len, wy / len, wz / len);
                    anyNormal = true;
                }
                put(vbytes, off + kOffsetNormal, n);
                float uv[2] = {0, 0};
                if (g.hasUv) {
                    uv[0] = g.uv[v * 2];
                    uv[1] = g.uv[v * 2 + 1];
                    anyUv = true;
                }
                std::memcpy(vbytes.data() + off + kOffsetUv, uv, 8);
                float c[4] = {ms.color[0], ms.color[1], ms.color[2], 1};
                if (ms.vertexColors && g.hasColor)
                    for (int k = 0; k < 4; k++)
                        c[k] *= g.color[v * 4 + k];
                uint16_t h[4] = {toHalf(c[0]), toHalf(c[1]), toHalf(c[2]), toHalf(c[3])};
                std::memcpy(vbytes.data() + off + kOffsetColor, h, 8);
                return out;
            };
            for (int64_t i = piece.start; i + 2 < piece.start + piece.count; i += 3) {
                uint32_t a = g.indexed ? g.index[size_t(i)] : uint32_t(i);
                uint32_t bb = g.indexed ? g.index[size_t(i + 1)] : uint32_t(i + 1);
                uint32_t c = g.indexed ? g.index[size_t(i + 2)] : uint32_t(i + 2);
                uint32_t ia = emit(a), ib = emit(bb), ic = emit(c);
                // Baked into world space, a mirrored object's triangles wind the other way: swap
                // two.
                if (mirrored)
                    std::swap(ib, ic);
                indices.push_back(ia);
                indices.push_back(ib);
                indices.push_back(ic);
            }
            uint32_t count = uint32_t(indices.size()) - firstIndex;
            if (count)
                b.members.push_back({oid, firstIndex, count, true});
        }
        b.sphere = unite(b.sphere, transformSphere(o.m, g.sphere));
        if (std::find(o.batches.begin(), o.batches.end(), b.id) == o.batches.end())
            o.batches.push_back(b.id);
    }
    if (b.members.empty() || !b.material) {
        for (uint32_t oid : members)
            if (auto it = objs_.find(oid); it != objs_.end()) {
                auto &list = it->second->batches;
                list.erase(std::remove(list.begin(), list.end(), b.id), list.end());
            }
        dropBatch(b.id);
        return;
    }
    auto gpu = std::make_shared<GpuVertices>();
    gpu->serial = nextSerial();
    gpu->count = b.vertices;
    gpu->normal = anyNormal;
    gpu->uv = anyUv;
    gpu->color = true;
    gpu->bytes = std::move(vbytes);
    b.gpu = gpu;
    auto gi = std::make_shared<GpuIndices>();
    gi->serial = nextSerial();
    gi->count = uint32_t(indices.size());
    gi->wide = b.vertices > 65535;
    if (gi->wide) {
        gi->bytes.resize(indices.size() * 4);
        std::memcpy(gi->bytes.data(), indices.data(), gi->bytes.size());
    } else {
        gi->bytes.resize(indices.size() * 2);
        for (size_t i = 0; i < indices.size(); i++) {
            uint16_t s = uint16_t(indices[i]);
            std::memcpy(gi->bytes.data() + i * 2, &s, 2);
        }
    }
    b.gpuIndex = gi;
}

// ---- Building the render state ------------------------------------------------------------------

std::shared_ptr<const GpuVertices> SceneModel::vertices(Geo &g) {
    if (g.gpu && g.gpuVersion == g.version)
        return g.gpu;
    auto gpu = std::make_shared<GpuVertices>();
    gpu->serial = nextSerial();
    gpu->count = g.count;
    gpu->normal = g.hasNormal;
    gpu->uv = g.hasUv;
    gpu->color = g.hasColor;
    gpu->bytes.resize(size_t(g.count) * kVertexStride);
    for (uint32_t v = 0; v < g.count; v++) {
        size_t off = size_t(v) * kVertexStride;
        std::memcpy(gpu->bytes.data() + off, &g.position[size_t(v) * 3], 12);
        uint32_t n =
            g.hasNormal ? packNormal(g.normal[v * 3], g.normal[v * 3 + 1], g.normal[v * 3 + 2]) : 0;
        put(gpu->bytes, off + kOffsetNormal, n);
        float uv[2] = {0, 0};
        if (g.hasUv) {
            uv[0] = g.uv[v * 2];
            uv[1] = g.uv[v * 2 + 1];
        }
        std::memcpy(gpu->bytes.data() + off + kOffsetUv, uv, 8);
        uint16_t h[4] = {0x3c00, 0x3c00, 0x3c00, 0x3c00}; // 1.0
        if (g.hasColor)
            for (int k = 0; k < 4; k++)
                h[k] = toHalf(g.color[v * 4 + k]);
        std::memcpy(gpu->bytes.data() + off + kOffsetColor, h, 8);
    }
    g.gpu = gpu;
    g.gpuVersion = g.version;
    if (g.indexed && (!g.gpuIndex || g.gpuIndex->count != g.index.size())) {
        auto gi = std::make_shared<GpuIndices>();
        gi->serial = nextSerial();
        gi->count = uint32_t(g.index.size());
        gi->wide = g.count > 65535;
        gi->bytes.resize(g.index.size() * (gi->wide ? 4 : 2));
        for (size_t i = 0; i < g.index.size(); i++) {
            if (gi->wide)
                std::memcpy(gi->bytes.data() + i * 4, &g.index[i], 4);
            else {
                uint16_t s = uint16_t(g.index[i]);
                std::memcpy(gi->bytes.data() + i * 2, &s, 2);
            }
        }
        g.gpuIndex = gi;
    }
    return g.gpu;
}

std::shared_ptr<const GpuIndices> SceneModel::wireframe(Geo &g) {
    if (g.gpuWire && g.wireVersion == g.version)
        return g.gpuWire;
    // three's WebGLGeometries.updateWireframeAttribute: every triangle's three edges.
    std::vector<uint32_t> w;
    uint32_t n = g.elements();
    w.reserve(size_t(n) * 2);
    for (uint32_t i = 0; i + 2 < n; i += 3) {
        uint32_t a = g.indexed ? g.index[i] : i, b = g.indexed ? g.index[i + 1] : i + 1,
                 c = g.indexed ? g.index[i + 2] : i + 2;
        w.insert(w.end(), {a, b, b, c, c, a});
    }
    auto gi = std::make_shared<GpuIndices>();
    gi->serial = nextSerial();
    gi->count = uint32_t(w.size());
    gi->wide = true;
    gi->bytes.resize(w.size() * 4);
    if (!w.empty())
        std::memcpy(gi->bytes.data(), w.data(), gi->bytes.size());
    g.gpuWire = gi;
    g.wireVersion = g.version;
    return gi;
}

ProgramKey SceneModel::programKey(const MaterialState &m, CullSide drawSide) const {
    ProgramKey k;
    k.model = m.model;
    k.multiview = options_.multiview;
    k.linearOutput = options_.srgbFramebuffer;
    bool shaderMat = m.model == ShadeModel::Beam || m.model == ShadeModel::SkyDome;
    k.fog = m.fog && !shaderMat ? fog_ : FogMode::None;
    k.sky = m.sky && skyOn_ && !shaderMat;
    k.map = m.map != 0;
    k.alphaMap = m.alphaMap != 0;
    k.emissiveMap = m.emissiveMap != 0 && m.lit;
    k.gradientMap = m.gradientMap != 0 && m.model == ShadeModel::Toon;
    k.alphaTest = m.alphaTest > 0;
    k.opaque = !m.transparent && m.blend.mode == BlendMode::Normal;
    k.premultipliedAlpha = m.premultipliedAlpha;
    k.doubleSided = drawSide == CullSide::Double;
    k.backSide = drawSide == CullSide::Back;
    k.shadows = m.lit && shadow_;
    k.flatShading = m.flatShading;
    k.sizeAttenuation = m.sizeAttenuation;
    return k;
}

void SceneModel::addItems(RenderState &state, Obj &o) {
    auto git = geos_.find(o.geo);
    if (git == geos_.end())
        return;
    Geo &g = *git->second;
    if (g.count == 0)
        return;
    auto verts = vertices(g);
    DrawMode mode = DrawMode::Triangles;
    switch (o.kind) {
    case ObjKind::Points:
        mode = DrawMode::Points;
        break;
    case ObjKind::Lines:
        mode = DrawMode::Lines;
        break;
    case ObjKind::LineStrip:
        mode = DrawMode::LineStrip;
        break;
    case ObjKind::LineLoop:
        mode = DrawMode::LineLoop;
        break;
    default:
        break;
    }
    Mat4 model = fromAffine(o.m);
    float nm[9];
    bool mirrored = normalMatrix(o.m, nm);
    Sphere sphere;
    if (!o.cull)
        sphere = {{o.m[9], o.m[10], o.m[11]}, INFINITY};
    else if (o.kind == ObjKind::Sprite)
        sphere = transformSphere(o.m, {{0, 0, 0}, 0.7071067811865476f});
    else if (o.kind == ObjKind::Instanced)
        sphere = transformSphere(o.m, o.instSphere);
    else
        sphere = transformSphere(o.m, g.sphere);
    auto push = [&](uint32_t mid, int64_t start, int64_t count) {
        auto mit = mats_.find(mid);
        if (mit == mats_.end())
            return;
        const auto &ms = mit->second->state;
        if (!ms->visible || !ms->drawable)
            return;
        bool wire = ms->wireframe && mode == DrawMode::Triangles;
        auto emit = [&](CullSide drawSide) {
            DrawItem it;
            it.vertices = verts;
            it.material = ms;
            it.mode = wire ? DrawMode::Lines : mode;
            if (wire) {
                it.indices = wireframe(g);
                it.first = uint32_t(start * 2);
                it.count = uint32_t(count * 2);
            } else {
                it.indices = g.indexed ? g.gpuIndex : nullptr;
                it.first = uint32_t(start);
                it.count = uint32_t(count);
            }
            it.instances = o.kind == ObjKind::Instanced ? o.gpuInst : nullptr;
            if (it.instances && it.instances->count == 0)
                return;
            std::copy(model.begin(), model.end(), it.model);
            std::copy(nm, nm + 9, it.normal);
            it.mirrored = mirrored && (o.kind == ObjKind::Mesh || o.kind == ObjKind::Instanced);
            it.useVertexColor = ms->vertexColors && g.hasColor;
            it.receiveShadow = o.recv;
            it.castShadow = o.cast;
            it.sphere = sphere;
            it.groupOrder = o.groupOrder;
            it.renderOrder = o.renderOrder;
            it.id = o.id;
            it.side = drawSide;
            it.spriteCenter[0] = o.center[0];
            it.spriteCenter[1] = o.center[1];
            it.key = programKey(*ms, drawSide);
            it.sharpText = sharpScreenMaterial(*ms) && it.mode == DrawMode::Triangles &&
                           !it.instances && o.kind == ObjKind::Mesh;
            it.sharpOverlay = sharpOverlayMaterial(*ms) && it.mode == DrawMode::Triangles &&
                              !it.instances &&
                              (o.kind == ObjKind::Mesh || o.kind == ObjKind::Sprite);
            if (it.sharpText)
                state.sharpItems++;
            ProgramKey d;
            d.model = ShadeModel::Depth;
            d.alphaTest = ms->alphaTest > 0;
            d.map = d.alphaTest && ms->map != 0;
            d.alphaMap = d.alphaTest && ms->alphaMap != 0;
            it.depthKey = d;
            state.items.push_back(std::move(it));
            for (uint32_t t : {ms->map, ms->alphaMap, ms->emissiveMap, ms->gradientMap})
                if (t)
                    state.textures.push_back(t);
        };
        // three draws a transparent double-sided material twice, back faces first (forceSinglePass
        // off).
        bool meshLike = o.kind == ObjKind::Mesh || o.kind == ObjKind::Instanced;
        if (meshLike && ms->transparent && ms->side == CullSide::Double && !ms->forceSinglePass &&
            !wire) {
            emit(CullSide::Back);
            emit(CullSide::Front);
        } else {
            emit(meshLike ? ms->side : CullSide::Double);
        }
    };
    int64_t total = g.elements();
    if (o.matArray) {
        // A material array draws per group; with no groups, three draws nothing.
        for (const auto &gr : g.groups) {
            if (gr[2] < 0 || size_t(gr[2]) >= o.mats.size())
                continue;
            int64_t s, c;
            if (clipRange(total, g.rangeStart, g.rangeCount, gr[0], gr[1], s, c))
                push(o.mats[size_t(gr[2])], s, c);
        }
    } else {
        int64_t s, c;
        if (clipRange(total, g.rangeStart, g.rangeCount, 0, -1, s, c))
            push(o.mats[0], s, c);
    }
}

std::shared_ptr<const RenderState> SceneModel::build() {
    auto state = std::make_shared<RenderState>();
    RenderState &s = *state;
    s.serial = ++stateSerial_;
    s.frame = frame_;
    s.sky = sky_;
    s.hasBackground = hasBackground_;
    std::copy(background_, background_ + 3, s.background);
    s.shadow = shadow_;
    std::copy(lightViewProj_, lightViewProj_ + 16, s.lightViewProj);
    s.shadowMapSize = shadowMapSize_;
    s.hasCamera = hasCamera_;
    std::copy(camera_, camera_ + 16, s.camera);
    s.items.reserve(objs_.size() + batches_.size() * 2);
    // Objects in a stable order (the renderer's sorts fall back on id, like three).
    std::vector<uint32_t> ids;
    ids.reserve(objs_.size());
    for (auto &[id, o] : objs_)
        ids.push_back(id);
    std::sort(ids.begin(), ids.end());
    uint64_t shadowHash = mix64(0, shadow_ ? 1 : 0);
    for (float f : lightViewProj_) {
        uint32_t b;
        std::memcpy(&b, &f, 4);
        shadowHash = mix64(shadowHash, b);
    }
    for (uint32_t id : ids) {
        Obj &o = *objs_.at(id);
        s.objects++;
        if (!o.visible)
            continue;
        s.visibleObjects++;
        if (!o.batches.empty()) {
            s.batchedObjects++;
            continue;
        }
        s.dynamicObjects++;
        size_t before = s.items.size();
        addItems(s, o);
        if (o.cast)
            for (size_t i = before; i < s.items.size(); i++) {
                const DrawItem &it = s.items[i];
                shadowHash = mix64(shadowHash, it.vertices->serial);
                shadowHash = mix64(shadowHash, it.material->version);
                shadowHash = mix64(shadowHash, it.instances ? it.instances->serial : 0);
                for (float f : o.m) {
                    uint32_t b;
                    std::memcpy(&b, &f, 4);
                    shadowHash = mix64(shadowHash, b);
                }
            }
    }
    std::vector<uint32_t> bids;
    for (auto &[id, b] : batches_)
        bids.push_back(id);
    std::sort(bids.begin(), bids.end());
    for (uint32_t bid : bids) {
        Batch &b = *batches_.at(bid);
        if (!b.gpu || !b.material)
            continue;
        s.staticBatches++;
        const MaterialState &ms = *b.material;
        // Contiguous runs of members still in: one draw each (a member that left is a gap).
        size_t i = 0;
        while (i < b.members.size()) {
            if (!b.members[i].active) {
                i++;
                continue;
            }
            uint32_t first = b.members[i].first, end = first + b.members[i].count;
            size_t j = i + 1;
            while (j < b.members.size() && b.members[j].active && b.members[j].first == end)
                end += b.members[j++].count;
            DrawItem it;
            it.vertices = b.gpu;
            it.indices = b.gpuIndex;
            it.material = b.material;
            it.mode = DrawMode::Triangles;
            it.first = first;
            it.count = end - first;
            it.bakedColor = true;
            it.useVertexColor = true;
            it.batch = true;
            it.receiveShadow = b.recv;
            it.castShadow = b.cast;
            it.sphere = b.sphere;
            it.groupOrder = b.groupOrder;
            it.renderOrder = b.renderOrder;
            it.id = 0x80000000u | bid;
            it.side = ms.side;
            it.key = programKey(ms, ms.side);
            it.sharpText = sharpScreenMaterial(ms);
            it.sharpOverlay = sharpOverlayMaterial(ms);
            if (it.sharpText)
                s.sharpItems++;
            ProgramKey d;
            d.model = ShadeModel::Depth;
            d.alphaTest = ms.alphaTest > 0;
            d.map = d.alphaTest && ms.map != 0;
            d.alphaMap = d.alphaTest && ms.alphaMap != 0;
            it.depthKey = d;
            if (b.cast) {
                shadowHash = mix64(shadowHash, b.gpu->serial);
                shadowHash = mix64(shadowHash, uint64_t(first) << 32 | it.count);
            }
            s.items.push_back(std::move(it));
            for (uint32_t t : {ms.map, ms.alphaMap, ms.emissiveMap, ms.gradientMap})
                if (t)
                    s.textures.push_back(t);
            i = j;
        }
    }
    std::sort(s.textures.begin(), s.textures.end());
    s.textures.erase(std::unique(s.textures.begin(), s.textures.end()), s.textures.end());
    {
        std::unordered_set<uint32_t> seen;
        auto warm = [&](const ProgramKey &k) {
            if (seen.insert(k.bits()).second)
                s.warmKeys.push_back(k);
        };
        for (const DrawItem &it : s.items) {
            warm(it.key);
            if (it.castShadow && shadow_)
                warm(it.depthKey);
        }
        for (auto &[mid, m] : mats_) {
            const MaterialState &ms = *m->state;
            if (!ms.drawable)
                continue;
            bool meshLike = ms.model != ShadeModel::Points && ms.model != ShadeModel::Line &&
                            ms.model != ShadeModel::Sprite;
            if (!meshLike) {
                warm(programKey(ms, CullSide::Double));
                continue;
            }
            if (ms.transparent && ms.side == CullSide::Double && !ms.forceSinglePass) {
                warm(programKey(ms, CullSide::Back));
                warm(programKey(ms, CullSide::Front));
            } else {
                warm(programKey(ms, ms.side));
            }
            if (shadow_) {
                ProgramKey d;
                d.model = ShadeModel::Depth;
                d.alphaTest = ms.alphaTest > 0;
                d.map = d.alphaTest && ms.map != 0;
                d.alphaMap = d.alphaTest && ms.alphaMap != 0;
                warm(d);
            }
        }
        // The screen layer's programs, only while some known material is a tagged screen.
        std::vector<const MaterialState *> sharp, overlays;
        for (auto &[mid, m] : mats_) {
            if (sharpScreenMaterial(*m->state))
                sharp.push_back(m->state.get());
            else if (sharpOverlayMaterial(*m->state))
                overlays.push_back(m->state.get());
        }
        if (!sharp.empty()) {
            std::unordered_set<uint32_t> sharpSeen;
            auto warmSharp = [&](ProgramKey k) {
                if (sharpSeen.insert(k.bits()).second)
                    s.sharpWarmKeys.push_back(k);
            };
            for (const MaterialState *ms : sharp)
                warmSharp(programKey(*ms, ms->side));
            for (const MaterialState *ms : overlays) {
                bool sprite = ms->model == ShadeModel::Sprite;
                // A static batch draws a double-sided layer once, with its own side; a dynamic
                // mesh draws back faces, then front faces.
                std::vector<CullSide> sides;
                if (sprite)
                    sides = {CullSide::Double};
                else if (ms->side == CullSide::Double && !ms->forceSinglePass)
                    sides = {CullSide::Double, CullSide::Back, CullSide::Front};
                else
                    sides = {ms->side};
                for (CullSide side : sides) {
                    ProgramKey k = programKey(*ms, side);
                    k.sharpOverlay = true;
                    warmSharp(k);
                }
            }
        }
    }
    s.shadowHash = shadowHash;
    s.geometries = uint32_t(geos_.size());
    s.materialCount = uint32_t(mats_.size());
    s.textureCount = uint32_t(textures_.size());
    s.unsupported = unsupported_;
    dirty_ = false;
    return state;
}

} // namespace office::scene
