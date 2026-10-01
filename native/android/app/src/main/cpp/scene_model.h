// The native scene's CPU state (GL-free). It applies wire packets (src/client/native/wire.ts),
// keeps the whole world, merges meshes that hold still into static batches, and on every commit
// publishes an immutable RenderState that the GL thread draws. One thread at a time (the renderer
// serializes).
#pragma once

#include "scene_math.h"
#include "scene_packet.h"
#include "scene_shaders.h"
#include "scene_uniforms.h"

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace office::scene {

// ---- What the GL thread uploads
// -------------------------------------------------------------------

/** Interleaved vertices, kVertexStride bytes each (see the offsets). */
constexpr uint32_t kVertexStride = 32;
constexpr uint32_t kOffsetPosition = 0; // 3 x float
constexpr uint32_t kOffsetNormal = 12;  // GL_INT_2_10_10_10_REV, normalized
constexpr uint32_t kOffsetUv = 16;      // 2 x float
constexpr uint32_t kOffsetColor = 24;   // 4 x half float, linear
/** Per instance: 3 rows of the 3x4 matrix (12 floats) and a linear color (3 floats). */
constexpr uint32_t kInstanceStride = 60;

/**
 * Buffers are written once on the model thread, then only read (and, after upload, released) by the
 * GL thread. `bytes` is mutable for that release; nothing else changes after publication.
 */
struct GpuVertices {
    uint64_t serial = 0;
    uint32_t count = 0;
    bool normal = false, uv = false, color = false;
    mutable std::vector<uint8_t> bytes;
};
struct GpuIndices {
    uint64_t serial = 0;
    uint32_t count = 0;
    bool wide = false; // uint32 indices, else uint16
    mutable std::vector<uint8_t> bytes;
};
struct GpuInstances {
    uint64_t serial = 0;
    uint32_t count = 0;
    bool color = false;
    mutable std::vector<uint8_t> bytes;
};

enum class DrawMode : uint8_t { Triangles, Lines, LineStrip, LineLoop, Points };
enum class CullSide : uint8_t { Front, Back, Double }; // which faces draw (three's Side)
enum class BlendMode : uint8_t { None, Normal, Additive, Subtractive, Multiply, Custom };

/** GL enum values (numeric, so this header stays GL-free). */
struct BlendState {
    BlendMode mode = BlendMode::Normal;
    bool premultiplied = false;
    uint32_t eq = 0x8006, eqAlpha = 0x8006; // GL_FUNC_ADD
    uint32_t src = 0x0302, dst = 0x0303;    // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
    uint32_t srcAlpha = 0x0302, dstAlpha = 0x0303;
};

/** A material as drawn: uniforms, textures and draw state. Immutable once published. */
struct MaterialState {
    uint32_t id = 0;
    uint64_t version = 0;
    ShadeModel model = ShadeModel::Basic;
    bool lit = false;
    bool drawable = true; // false: an unknown ShaderMaterial (reported by the exporter)
    bool visible = true;
    bool transparent = false;
    float color[4] = {1, 1, 1, 1}; // rgb linear, a opacity
    float emissive[3] = {0, 0, 0};
    float alphaTest = 0;
    uint32_t map = 0, alphaMap = 0, emissiveMap = 0, gradientMap = 0; // texture ids (0 none)
    float mapTransform[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    float alphaMapTransform[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    float emissiveMapTransform[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    CullSide side = CullSide::Front, shadowSide = CullSide::Back;
    bool depthTest = true, depthWrite = true, colorWrite = true;
    uint32_t depthFunc = 0x0203; // GL_LEQUAL
    BlendState blend;
    bool polygonOffset = false;
    float polygonOffsetFactor = 0, polygonOffsetUnits = 0;
    bool wireframe = false, forceSinglePass = false, vertexColors = false;
    bool fog = false, sky = false, flatShading = false, sizeAttenuation = true,
         premultipliedAlpha = false;
    float pointSize = 1, rotation = 0, metalness = 0, roughness = 1;
    float specular[4] = {0.067f, 0.067f, 0.067f, 30};
    float skyUniforms[5][4] = {}; // SkyDome: top, horizon, glow + glowK, moonDir, moonGlow
    bool sharpText = false; // the wire's sharpText: also drawn in the high-resolution screen layer
};

struct DrawItem {
    std::shared_ptr<const GpuVertices> vertices;
    std::shared_ptr<const GpuIndices> indices;     // null: glDrawArrays
    std::shared_ptr<const GpuInstances> instances; // null: not instanced
    std::shared_ptr<const MaterialState> material;
    DrawMode mode = DrawMode::Triangles;
    CullSide side = CullSide::Front; // the side this draw shows (a two-pass double-sided
                                     // transparent draws twice)
    bool useVertexColor = false;     // enable the color array (else the constant (1,1,1,1))
    uint32_t first = 0, count = 0;
    float model[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    float normal[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    bool mirrored = false;   // negative determinant: front faces wind clockwise
    bool bakedColor = false; // a static batch: the material color is in the vertices
    bool receiveShadow = false, castShadow = false, batch = false;
    Sphere sphere; // world space; infinite when not frustum culled
    int32_t groupOrder = 0, renderOrder = 0;
    uint32_t id = 0; // the object id (batches: 0x80000000 | batch id), for stable sorts
    float spriteCenter[2] = {0.5f, 0.5f};
    /** Drawn again by renderSharpScreens: an opaque, mapped, non-instanced MeshBasicMaterial
     * triangle draw whose material is tagged sharpText. */
    bool sharpText = false;
    /** renderSharpScreens may draw it over the screens: a transparent mesh or sprite that does not
     * write the world depth, so the screen occlusion test cannot see it. */
    bool sharpOverlay = false;
    /**
     * The controller (0 left, 1 right) this item is drawn on, else -1. model, normal, mirrored and
     * sphere are then relative to that grip; the renderer composes them with the display frame's
     * grip and hides the item without one. Never batched, casts no shadow, not in the screen layer.
     */
    int8_t attachment = -1;
    ProgramKey key;      // the color pass
    ProgramKey depthKey; // the shadow pass (castShadow only)
};

struct RenderState {
    uint64_t serial = 0;
    std::vector<DrawItem> items;
    /** Textures any item samples, for the renderer's upload priority. */
    std::vector<uint32_t> textures;
    /**
     * Programs any known material may need (hidden objects' too, and shadow-pass variants), unique,
     * so the renderer can link them ahead of the frame an object first shows.
     */
    std::vector<ProgramKey> warmKeys;
    /**
     * Color-pass keys (sharpDepth None) the screen layer draws with: tagged screens, then overlays
     * (sharpOverlay set). Empty when no known material is tagged. The renderer links the
     * SharpDepth variants it may use after warmKeys, with links left over.
     */
    std::vector<ProgramKey> sharpWarmKeys;
    uint32_t sharpItems = 0;    // items with sharpText
    uint32_t attachedItems = 0; // items with an attachment
    FrameBlock frame;
    SkyBlock sky;
    bool hasBackground = false;
    float background[3] = {0, 0, 0}; // linear
    bool shadow = false;
    float lightViewProj[16] = {};
    int shadowMapSize = 0;
    uint64_t shadowHash = 0; // changes when anything the shadow map shows changes
    bool hasCamera = false;
    float camera[16] = {};
    // Counts for stats.
    uint32_t objects = 0, visibleObjects = 0, staticBatches = 0, batchedObjects = 0,
             dynamicObjects = 0;
    uint32_t geometries = 0, materialCount = 0, textureCount = 0, unsupported = 0;
};

/** A texture change for the GL thread, in order. */
struct TextureOp {
    enum Kind : uint8_t { Upload, Sampler, Remove, Clear } kind = Upload;
    uint32_t id = 0;
    uint32_t rev = 0;
    Image image; // Upload only
    // Sampler (Upload and Sampler): GL enum values.
    uint32_t wrapS = 0x2901, wrapT = 0x2901, mag = 0x2601, min = 0x2601;
    bool mips = false, srgb = false;
    float aniso = 1;
    size_t bytes() const { return image.rgba.size(); }
};

struct ModelOptions {
    bool multiview = false;
    bool srgbFramebuffer = true;
    bool shadows = true;
    float staticAfterSeconds = 1.5f;
    float rebuildDelaySeconds = 1.5f;
    float maxStaticAfterSeconds = 30.f;
    float cellSize = 16.f;
    uint32_t maxBatchVertices = 1u << 20;
    Limits limits;
};

struct ApplyResult {
    bool committed = false;
    std::shared_ptr<const RenderState> state; // on commit (and on tick when batching changed)
    std::vector<TextureOp> textures;
};

class SceneModel {
  public:
    explicit SceneModel(const ModelOptions &options);
    ~SceneModel();

    /**
     * Applies one v1 packet. Throws PacketError on anything malformed; the model then refuses
     * packets until one with `reset: true` (needsReset()). Out-of-order `seq` also throws.
     */
    ApplyResult apply(const json &packet, double nowSeconds);
    /** Merges meshes that have held still long enough; a state when anything changed. */
    ApplyResult tick(double nowSeconds);

    bool needsReset() const { return needsReset_; }
    uint64_t lastSeq() const { return seq_; }
    uint64_t commits() const { return commits_; }
    size_t blobBytes() const { return blobs_.bytes(); }

  private:
    struct Geo;
    struct Mat;
    struct Obj;
    struct Batch;

    void clear(std::vector<TextureOp> &ops);
    void applyTexture(const json &t, std::vector<TextureOp> &ops);
    void applyGeometry(const json &g, double now);
    void applyMaterial(const json &m, double now);
    void applyObject(const json &o, double now);
    void applyInstances(Obj &o, const json &inst);
    void applyTransforms(const json &xf, double now);
    void applyVisibility(const json &ids, bool visible);
    void applyEnv(const json &env);
    void applyCamera(const json &c);
    void remove(const json &r, std::vector<TextureOp> &ops);
    void removeObject(uint32_t id);

    /** The object moved, or its geometry or material changed: out of its batch, and wait again. */
    void unsettle(Obj &o, double now);
    void evict(Obj &o);
    bool eligible(const Obj &o, double now) const;
    std::string placeKey(const Obj &o) const;
    void updateBatches(double now);
    void rebuild(Batch &b, std::vector<uint32_t> members, double now);
    void dropBatch(uint32_t id);

    std::shared_ptr<const RenderState> build();
    std::shared_ptr<const GpuVertices> vertices(Geo &g);
    std::shared_ptr<const GpuIndices> wireframe(Geo &g);
    ProgramKey programKey(const MaterialState &m, CullSide side) const;
    void addItems(RenderState &state, Obj &o);

    ModelOptions options_;
    BlobStore blobs_;
    uint64_t seq_ = 0;
    bool needsReset_ = true;
    bool uncommitted_ = false; // a snapshot is half applied: publish nothing until its commit
    bool dirty_ = false;       // something changed since the last published state
    uint64_t commits_ = 0;
    uint64_t stateSerial_ = 0;
    double lastBatchCheck_ = -1e9;

    std::unordered_map<uint32_t, std::unique_ptr<Geo>> geos_;
    std::unordered_map<uint32_t, std::unique_ptr<Mat>> mats_;
    std::unordered_map<uint32_t, std::unique_ptr<Obj>> objs_;
    std::unordered_map<uint32_t, std::unique_ptr<Batch>> batches_;
    std::unordered_map<std::string, std::vector<uint32_t>> batchByKey_;
    std::unordered_set<uint32_t> textures_;
    uint32_t nextBatch_ = 1;

    // Environment, as the shaders take it.
    FrameBlock frame_;
    SkyBlock sky_;
    bool skyOn_ = false;
    FogMode fog_ = FogMode::None;
    bool hasBackground_ = false;
    float background_[3] = {0, 0, 0};
    bool shadow_ = false;
    float lightViewProj_[16] = {};
    int shadowMapSize_ = 0;
    bool hasCamera_ = false;
    float camera_[16] = {};
    uint32_t unsupported_ = 0;
};

/**
 * Whether `m` (column-major 4x4) can hold attached items: finite, affine, and a rotation plus
 * translation (orthonormal within `tolerance`, determinant +1). A grip pose is always rigid.
 */
inline bool rigidPose(const float m[16], float tolerance = 1e-3f) {
    for (int i = 0; i < 16; i++)
        if (!std::isfinite(m[i]))
            return false;
    if (m[3] != 0 || m[7] != 0 || m[11] != 0 || m[15] != 1)
        return false;
    const Vec3 x{m[0], m[1], m[2]}, y{m[4], m[5], m[6]}, z{m[8], m[9], m[10]};
    auto off = [&](float v, float want) { return std::fabs(v - want) > tolerance; };
    if (off(dot(x, x), 1) || off(dot(y, y), 1) || off(dot(z, z), 1) || off(dot(x, y), 0) ||
        off(dot(y, z), 0) || off(dot(z, x), 0))
        return false;
    const Vec3 c{x.y * y.z - x.z * y.y, x.z * y.x - x.x * y.z, x.x * y.y - x.y * y.x};
    return !off(dot(c, z), 1);
}

/**
 * Places an attached item (DrawItem::attachment) at a rigid `grip`: `out` gets grip *
 * relative.model with its normal matrix and bounding sphere. `out` must otherwise be a copy of
 * `relative`. Matrix-only: no allocation.
 */
inline void placeAttachment(const DrawItem &relative, const float grip[16], DrawItem &out) {
    Mat4 g, rel;
    std::copy(grip, grip + 16, g.begin());
    std::copy(relative.model, relative.model + 16, rel.begin());
    const Mat4 world = multiply(g, rel);
    std::copy(world.begin(), world.end(), out.model);
    float affine[12];
    toAffine(world, affine);
    normalMatrix(affine, out.normal);
    // A rigid grip keeps the determinant's sign and every length: the winding and radius stay.
    out.mirrored = relative.mirrored;
    float gripAffine[12];
    toAffine(g, gripAffine);
    out.sphere.c = relative.sphere.infinite() ? Vec3{grip[12], grip[13], grip[14]}
                                              : transformPoint(gripAffine, relative.sphere.c);
    out.sphere.r = relative.sphere.r;
}

/** A tagged laptop screen the high-resolution layer redraws (DrawItem::sharpText). */
bool sharpScreenMaterial(const MaterialState &m);
/** A see-through surface missing from the world depth, redrawn over the screens. */
bool sharpOverlayMaterial(const MaterialState &m);

/** Hash-combine for the renderer's caches and shadow hash. */
inline uint64_t mix64(uint64_t h, uint64_t v) {
    h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
    return h;
}

/** A process-wide unique serial for GPU buffers. */
uint64_t nextSerial();

} // namespace office::scene
