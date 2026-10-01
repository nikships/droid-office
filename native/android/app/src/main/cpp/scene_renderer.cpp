#include "scene_renderer.h"

#include "scene_model.h"
#include "scene_stream.h"

#include <EGL/egl.h>
#include <GLES3/gl3.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <mutex>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

#ifdef __ANDROID__
#include <android/log.h>
#define SCENE_LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeScene", __VA_ARGS__)
#else
#include <cstdio>
#define SCENE_LOG(...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))
#endif

#ifndef GL_TIME_ELAPSED_EXT
#define GL_TIME_ELAPSED_EXT 0x88BF
#endif
#ifndef GL_GPU_DISJOINT_EXT
#define GL_GPU_DISJOINT_EXT 0x8FBB
#endif
#ifndef GL_TEXTURE_MAX_ANISOTROPY_EXT
#define GL_TEXTURE_MAX_ANISOTROPY_EXT 0x84FE
#endif
#ifndef GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT
#define GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT 0x84FF
#endif
#ifndef GL_COMPLETION_STATUS_KHR
#define GL_COMPLETION_STATUS_KHR 0x91B1
#endif

namespace office {

using namespace office::scene;
using Clock = std::chrono::steady_clock;

namespace {

double seconds() { return std::chrono::duration<double>(Clock::now().time_since_epoch()).count(); }

bool hasExtension(const char *name) {
    GLint n = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &n);
    for (GLint i = 0; i < n; i++) {
        const char *e = reinterpret_cast<const char *>(glGetStringi(GL_EXTENSIONS, GLuint(i)));
        if (e && std::strcmp(e, name) == 0)
            return true;
    }
    return false;
}

const void *offset(size_t bytes) { return reinterpret_cast<const void *>(uintptr_t(bytes)); }

typedef void (*MaxShaderCompilerThreadsFn)(GLuint count);

/**
 * A program being built or built. With GL_KHR_parallel_shader_compile both compiles and the link
 * start together and the result is read once the driver reports completion. Without it each compile
 * and the link is its own budgeted step (a driver may do each synchronously), and the result is
 * read a frame after the link, so no frame waits for more than one step.
 */
struct Program : ScenePipeline {
    GLuint id = 0, vs = 0, fs = 0;
    enum Stage : uint8_t { Vertex, Fragment, Linking } stage = Vertex; // the step done last
    bool ready = false, failed = false;
    uint64_t linkedFrame = 0;
    ProgramKey key;
    ShaderSource src; // until the link starts
    GLint uModel = -1, uNormalMatrix = -1, uColor = -1, uEmissive = -1, uAlphaTest = -1;
    GLint uMapTransform = -1, uAlphaMapTransform = -1, uEmissiveMapTransform = -1;
    GLint uReceiveShadow = -1, uPointSize = -1, uPointQuad = -1, uSpriteCenter = -1,
          uSpriteRotation = -1;
    GLint uMetalRough = -1, uSpecular = -1, uLightViewProj = -1;
    GLint uSky[5] = {-1, -1, -1, -1, -1};
    GLint uSharpRect = -1, uSharpParams = -1, uSharpBias = -1;
};

/** A GL buffer for one GpuVertices/GpuIndices/GpuInstances, alive while the model holds that
 * object. */
struct Buffer {
    GLuint id = 0;
    GLenum target = GL_ARRAY_BUFFER;
    size_t size = 0, uploaded = 0;
    std::weak_ptr<const void> owner;
    // Vertex buffers: the positions' box, gathered while uploading because the CPU copy is then
    // released. boxValid is false for an empty buffer or a non-finite position.
    float lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
    bool boxValid = true, boxAny = false;
    bool ready() const { return uploaded >= size; }
};

struct TextureSlot {
    GLuint id = 0;
    int w = 0, h = 0;
    uint32_t wrapS = GL_CLAMP_TO_EDGE, wrapT = GL_CLAMP_TO_EDGE, mag = GL_LINEAR, min = GL_LINEAR;
    bool mips = false;
    float aniso = 1;
};

/** A texture uploaded in row bands into a new texture object, swapped in once complete. */
struct UploadJob {
    TextureOp op;
    GLuint tex = 0;
    int row = 0;
};

struct VaoEntry {
    GLuint id = 0;
    uint64_t vertices = 0, indices = 0, instances = 0;
};

GLuint startCompile(GLenum type, const std::string &src) {
    GLuint s = glCreateShader(type);
    const char *p = src.c_str();
    glShaderSource(s, 1, &p, nullptr);
    glCompileShader(s);
    return s;
}

/** The compile log of a shader that failed, else empty. */
std::string compileError(GLuint s) {
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (ok)
        return {};
    char buf[4096];
    GLsizei n = 0;
    glGetShaderInfoLog(s, sizeof buf, &n, buf);
    return n > 0 ? std::string(buf, size_t(n)) : std::string("(no log)");
}

void setMat3(GLint loc, const float *m) {
    if (loc >= 0)
        glUniformMatrix3fv(loc, 1, GL_FALSE, m);
}

float srgbEncode(float c) {
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}

} // namespace

struct SceneRenderer::Impl final : SceneResidency {
    SceneRendererOptions options;
    // The bridge side (packets, backpressure, the newest state and its texture changes) and the
    // frame planning (culling, draw order, attachments, the screen layer's plan) are shared with
    // the other backends: scene_stream.h and scene_frame.h.
    SceneStream stream;
    SceneFramePlanner frame;

    mutable std::mutex statsMutex; // guards frameStats, read by stats() on any thread
    SceneStats frameStats;

    // ---- GL thread
    // --------------------------------------------------------------------------------
    bool initialized = false;
    bool timerSupported = false;
    bool parallelCompile = false;
    float maxAniso = 1;
    std::vector<uint32_t> compiling; // program keys started and not yet checked
    std::vector<ProgramKey> wanted;  // requested while drawing, started by the next prepareFrame
    uint32_t programsFailed = 0;
    bool drawing = false;
    uint64_t warmedSerial = 0, sharpWarmedSerial = 0;
    bool sharpDepthKindReported = false, sharpPlanReported = false;
    bool usedMultiview = false, usedSingle = false;
    // The program variants the draws use (render: single view; renderStereo: multiview when
    // enabled).
    bool wantMultiview = false, wantSingle = true;
    std::shared_ptr<const RenderState> current; // drawn
    std::shared_ptr<const RenderState> pending; // uploading, adopted once complete
    double pendingSince = 0;
    std::unordered_map<uint64_t, Buffer> buffers; // by serial
    std::unordered_map<uint64_t, VaoEntry> vaos;
    std::unordered_map<uint32_t, Program> programs; // by ProgramKey::bits()
    std::unordered_map<uint32_t, TextureSlot> textures;
    std::deque<UploadJob> jobs;
    GLuint white = 0, clearTex = 0, fallbackShadow = 0;
    GLuint shadowTex = 0, shadowFbo = 0;
    int shadowSize = 0;
    uint64_t shadowHash = ~0ull;
    // Uniform buffers: view blocks are rewritten per render call, frame and sky blocks per frame.
    // The ring is deep enough that the GPU is done with a buffer (two calls a frame, three frames
    // in flight) before it is written again.
    // Two-pass stereo with the screen layer writes four view blocks a frame.
    static constexpr int kUboRing = 12;
    GLuint viewUbo[kUboRing][2] = {}, frameUbo[kUboRing] = {}, skyUbo[kUboRing] = {};
    int ring = 0, stateRing = 0;
    uint64_t frameNumber = 0;
    float gpuMs = -1;

    // Per prepareFrame.
    FrameBudget work;      // upload bytes and program starts left, CPU deadline
    bool prepared = false; // prepareFrame ran at least once
    bool autoPrepare =
        true; // the caller never called prepareFrame: every render call runs it first
    float prepareMs = 0, drawMs = 0, windowMax = 0, cpuMaxMs = 0;
    int windowFrames = 0;
    bool cpuWindowDone = false;

    // The planner's draws; `program` is always this renderer's Program.
    using Draw = SceneDraw;
    using Rect = PixelRect;
    static const Program &asProgram(const Draw &d) {
        return *static_cast<const Program *>(d.program);
    }
    GLuint sharpSampler = 0; // nearest, clamped, no comparison, whatever the depth texture's state
    SceneStats stats;

    explicit Impl(const SceneRendererOptions &o)
        : options(o), stream(streamOptions(o)), frame(planOptions(o)) {}

    static ModelOptions modelOptions(const SceneRendererOptions &o) {
        ModelOptions m;
        m.multiview = o.multiview;
        m.srgbFramebuffer = o.srgbFramebuffer;
        m.shadows = o.shadows;
        m.staticAfterSeconds = o.staticAfterSeconds;
        return m;
    }

    static SceneStreamOptions streamOptions(const SceneRendererOptions &o) {
        SceneStreamOptions s;
        s.model = modelOptions(o);
        s.maxPacketBytes = o.maxPacketBytes;
        s.maxQueuedBytes = o.maxQueuedBytes;
        return s;
    }

    static ScenePlanOptions planOptions(const SceneRendererOptions &o) {
        ScenePlanOptions p;
        p.multiview = o.multiview;
        p.sharpMaxDistance = o.sharpMaxDistance;
        p.sharpMaxScreens = o.sharpMaxScreens;
        p.sharpMaxOverlays = o.sharpMaxOverlays;
        p.sharpCropToScreens = o.sharpCropToScreens;
        return p;
    }

    void fail(const std::string &message) {
        SCENE_LOG("%s", message.c_str());
        stream.setError(message);
    }

    // ---- SceneResidency: what the planner asks about this renderer's GL objects ---------------

    const ScenePipeline *drawPipeline(const ProgramKey &key) override {
        const Program *p = program(key);
        return p && !p->failed ? p : nullptr;
    }

    const ScenePipeline *readyPipeline(const ProgramKey &key) const override {
        return readyProgram(key);
    }

    bool textureResident(uint32_t id) const override { return textures.count(id) != 0; }

    bool vertexBox(uint64_t serial, float lo[3], float hi[3]) const override {
        auto b = buffers.find(serial);
        if (b == buffers.end() || !b->second.ready() || !b->second.boxValid || !b->second.boxAny)
            return false;
        std::copy(b->second.lo, b->second.lo + 3, lo);
        std::copy(b->second.hi, b->second.hi + 3, hi);
        return true;
    }

    // ---- GL thread: resources -------------------------------------------------------------------

    GLuint makeTexture(const uint8_t rgba[4]) {
        GLuint t = 0;
        glGenTextures(1, &t);
        glBindTexture(GL_TEXTURE_2D, t);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        return t;
    }

    static void depthParams() {
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_FUNC, GL_LEQUAL);
    }

    /** (Re)creates the shadow map at `size`. Leaves shadowFbo bound to GL_FRAMEBUFFER: callers
     * restore theirs. */
    void ensureShadowMap(int size) {
        if (shadowTex && shadowSize == size)
            return;
        if (shadowFbo)
            glDeleteFramebuffers(1, &shadowFbo);
        if (shadowTex)
            glDeleteTextures(1, &shadowTex);
        glActiveTexture(GL_TEXTURE0);
        glGenTextures(1, &shadowTex);
        glBindTexture(GL_TEXTURE_2D, shadowTex);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH_COMPONENT24, size, size);
        depthParams();
        glGenFramebuffers(1, &shadowFbo);
        glBindFramebuffer(GL_FRAMEBUFFER, shadowFbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, shadowTex, 0);
        GLenum none = GL_NONE;
        glDrawBuffers(1, &none);
        glReadBuffer(GL_NONE);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            fail("shadow framebuffer is incomplete");
        shadowSize = size;
        shadowHash = ~0ull;
        std::fill(std::begin(gl.bound), std::end(gl.bound), ~0u);
    }

    /**
     * The program for `key` if it is linked and usable, else null. The first request starts its
     * compile and link (within this frame's link budget); a later frame finishes it. `failed`
     * programs stay in the cache (and return null) so a broken key is not retried every frame.
     */
    const Program *program(ProgramKey key) {
        uint32_t bits = key.bits();
        auto it = programs.find(bits);
        if (it == programs.end()) {
            // Draws never start a build (it would stall the eye pass); the next prepareFrame does.
            if (!drawing)
                startProgram(key);
            else if (std::find(wanted.begin(), wanted.end(), key) == wanted.end())
                wanted.push_back(key);
            return nullptr;
        }
        Program &p = it->second;
        if (p.ready)
            return &p;
        if (!p.failed && !drawing)
            advanceProgram(p);
        return p.ready ? &p : nullptr;
    }

    void startProgram(ProgramKey key) {
        if (work.links <= 0 || !mayWork())
            return;
        work.links--;
        work.worked = true;
        Program &p = programs[key.bits()];
        p.key = key;
        p.src = generateShader(key);
        p.vs = startCompile(GL_VERTEX_SHADER, p.src.vertex);
        p.stage = Program::Vertex;
        compiling.push_back(key.bits());
        if (parallelCompile) {
            p.fs = startCompile(GL_FRAGMENT_SHADER, p.src.fragment);
            link(p);
        }
    }

    void link(Program &p) {
        p.id = glCreateProgram();
        glAttachShader(p.id, p.vs);
        glAttachShader(p.id, p.fs);
        glLinkProgram(p.id);
        p.stage = Program::Linking;
        p.linkedFrame = frameNumber;
        p.src = {};
    }

    /** Runs the next step of a program build when it is due and the frame has budget left. */
    void advanceProgram(Program &p) {
        if (p.stage == Program::Linking) {
            if (parallelCompile) {
                GLint done = 0;
                glGetProgramiv(p.id, GL_COMPLETION_STATUS_KHR, &done);
                if (done)
                    finishProgram(p);
            } else if (frameNumber > p.linkedFrame && mayWork()) {
                work.worked = true;
                finishProgram(p);
            }
            return;
        }
        if (!mayWork())
            return;
        work.worked = true;
        if (p.stage == Program::Vertex) {
            p.fs = startCompile(GL_FRAGMENT_SHADER, p.src.fragment);
            p.stage = Program::Fragment;
        } else {
            link(p);
        }
    }

    /** Reads a finished link: the program is then ready (locations and bindings set) or failed. */
    void finishProgram(Program &p) {
        compiling.erase(std::remove(compiling.begin(), compiling.end(), p.key.bits()),
                        compiling.end());
        GLint ok = 0;
        glGetProgramiv(p.id, GL_LINK_STATUS, &ok);
        if (!ok) {
            std::string log = compileError(p.vs);
            if (log.empty())
                log = compileError(p.fs);
            if (log.empty()) {
                char buf[4096];
                GLsizei n = 0;
                glGetProgramInfoLog(p.id, sizeof buf, &n, buf);
                log.assign(buf, size_t(std::max<GLsizei>(n, 0)));
            }
            glDeleteShader(p.vs);
            glDeleteShader(p.fs);
            glDeleteProgram(p.id);
            p.vs = p.fs = p.id = 0;
            p.failed = true;
            programsFailed++;
            fail("shader " + programName(p.key) + " failed: " + log);
            return;
        }
        glDetachShader(p.id, p.vs);
        glDetachShader(p.id, p.fs);
        glDeleteShader(p.vs);
        glDeleteShader(p.fs);
        p.vs = p.fs = 0;
        auto block = [&](const char *name, GLuint binding) {
            GLuint index = glGetUniformBlockIndex(p.id, name);
            if (index != GL_INVALID_INDEX)
                glUniformBlockBinding(p.id, index, binding);
        };
        block("Frame", kBlockFrame);
        block("Sky", kBlockSky);
        block("View", kBlockView);
        glUseProgram(p.id);
        gl.program = p.id;
        auto loc = [&](const char *name) { return glGetUniformLocation(p.id, name); };
        auto sampler = [&](const char *name, GLint unit) {
            GLint l = loc(name);
            if (l >= 0)
                glUniform1i(l, unit);
        };
        sampler("uMap", kUnitMap);
        sampler("uAlphaMap", kUnitAlphaMap);
        sampler("uEmissiveMap", kUnitEmissiveMap);
        sampler("uGradientMap", kUnitGradientMap);
        sampler("uShadowMap", kUnitShadowMap);
        sampler("uSharpDepth", kUnitSharpDepth);
        p.uSharpRect = loc("uSharpRect");
        p.uSharpParams = loc("uSharpParams");
        p.uSharpBias = loc("uSharpBias");
        p.uModel = loc("uModel");
        p.uNormalMatrix = loc("uNormalMatrix");
        p.uColor = loc("uColor");
        p.uEmissive = loc("uEmissive");
        p.uAlphaTest = loc("uAlphaTest");
        p.uMapTransform = loc("uMapTransform");
        p.uAlphaMapTransform = loc("uAlphaMapTransform");
        p.uEmissiveMapTransform = loc("uEmissiveMapTransform");
        p.uReceiveShadow = loc("uReceiveShadow");
        p.uPointSize = loc("uPointSize");
        p.uPointQuad = loc("uPointQuad");
        p.uSpriteCenter = loc("uSpriteCenter");
        p.uSpriteRotation = loc("uSpriteRotation");
        p.uMetalRough = loc("uMetalRough");
        p.uSpecular = loc("uSpecular");
        p.uLightViewProj = loc("uLightViewProj");
        const char *sky[5] = {"uSky0", "uSky1", "uSky2", "uSky3", "uSky4"};
        for (int i = 0; i < 5; i++)
            p.uSky[i] = loc(sky[i]);
        p.ready = true;
    }

    /** Checks every started link that may be done (one pass per frame). */
    void pollPrograms() {
        std::vector<uint32_t> keys = compiling;
        for (uint32_t k : keys) {
            auto it = programs.find(k);
            if (it != programs.end() && !it->second.ready && !it->second.failed)
                advanceProgram(it->second);
        }
        std::vector<ProgramKey> keys2;
        keys2.swap(wanted);
        for (const ProgramKey &k : keys2)
            if (!programs.count(k.bits())) {
                if (work.links > 0 && mayWork())
                    startProgram(k);
                else
                    wanted.push_back(k);
            }
    }

    /** Whether budgeted work may start now: always the first piece of a frame, then within the time
     * budget. */
    bool mayWork() const { return work.mayWork(); }

    /**
     * Uploads (part of) a buffer within the frame budget; true once all of it is on the GPU. Large
     * buffers go up in bands over several frames. The CPU copy is released after the upload: the GL
     * buffer then lives as long as the model holds the object, so it never needs the bytes again.
     */
    template <typename T> bool upload(GLenum target, const std::shared_ptr<const T> &src) {
        auto it = buffers.find(src->serial);
        if (it != buffers.end() && it->second.ready())
            return true;
        if (work.bytes == 0 || !mayWork())
            return false;
        work.worked = true;
        if (it == buffers.end()) {
            Buffer b;
            b.target = target;
            b.size = src->bytes.size();
            b.owner = src;
            glGenBuffers(1, &b.id);
            glBindBuffer(target, b.id);
            glBufferData(target, GLsizeiptr(std::max<size_t>(b.size, 4)), nullptr, GL_STATIC_DRAW);
            it = buffers.emplace(src->serial, b).first;
        }
        Buffer &b = it->second;
        size_t n = std::min(b.size - b.uploaded, work.bytes);
        if constexpr (std::is_same_v<T, GpuVertices>)
            extendBox(b, *src, b.uploaded, b.uploaded + n);
        glBindBuffer(target, b.id);
        glBufferSubData(target, GLintptr(b.uploaded), GLsizeiptr(n),
                        src->bytes.data() + b.uploaded);
        b.uploaded += n;
        work.bytes -= n;
        stats.uploadedBytesLastFrame += n;
        if (!b.ready())
            return false;
        src->bytes.clear();
        src->bytes.shrink_to_fit();
        return true;
    }

    /** Adds the positions of the vertices that start in bytes [from, to) to the buffer's box. */
    static void extendBox(Buffer &b, const GpuVertices &src, size_t from, size_t to) {
        size_t first = (from + kVertexStride - 1) / kVertexStride;
        size_t last = std::min<size_t>((to + kVertexStride - 1) / kVertexStride, src.count);
        for (size_t v = first; v < last; v++) {
            size_t at = v * kVertexStride + kOffsetPosition;
            if (at + 3 * sizeof(float) > src.bytes.size()) {
                b.boxValid = false;
                return;
            }
            float p[3];
            std::memcpy(p, src.bytes.data() + at, sizeof p);
            for (int k = 0; k < 3; k++) {
                if (!std::isfinite(p[k]))
                    b.boxValid = false;
                b.lo[k] = std::min(b.lo[k], p[k]);
                b.hi[k] = std::max(b.hi[k], p[k]);
            }
            b.boxAny = true;
        }
    }

    bool texturesResident(const RenderState &s) const {
        for (uint32_t id : s.textures)
            if (!textures.count(id))
                return false;
        return true;
    }

    /** Starts or finishes the program for `key`; true once it is linked or has failed. */
    bool settled(ProgramKey key) {
        program(key);
        auto it = programs.find(key.bits());
        return it != programs.end() && (it->second.ready || it->second.failed);
    }

    /** `key` for each program variant the render calls use (multiview and/or single view). */
    template <typename F> void variants(ProgramKey key, F &&f) {
        if (key.model == ShadeModel::Depth) {
            f(key);
            return;
        }
        if (wantMultiview) {
            key.multiview = true;
            f(key);
        }
        if (wantSingle) {
            key.multiview = false;
            f(key);
        }
    }

    /** Uploads what `s` needs; true when every buffer and program it draws with is ready. */
    bool prepare(const RenderState &s) {
        bool ready = true;
        glBindVertexArray(0);
        gl.vao = 0;
        for (const DrawItem &it : s.items) {
            ready &= upload(GL_ARRAY_BUFFER, it.vertices);
            if (it.indices)
                ready &= upload(GL_ELEMENT_ARRAY_BUFFER, it.indices);
            if (it.instances)
                ready &= upload(GL_ARRAY_BUFFER, it.instances);
            variants(it.key, [&](ProgramKey k) { ready &= settled(k); });
            if (s.shadow && it.castShadow)
                ready &= settled(it.depthKey);
        }
        return ready;
    }

    /**
     * The screen layer's variants of a color-pass key: multiview draws one pass that samples the
     * depth array by view; single view samples a 2D depth or one layer of an array.
     */
    template <typename F> void sharpVariants(ProgramKey key, F &&f) const {
        sharpKeyVariants(options.multiview, key, std::forward<F>(f));
    }

    /** Links the screen layer's programs, after the world's, with links left over. */
    void warmSharp(const RenderState &s) {
        if (sharpWarmedSerial == s.serial)
            return;
        for (const ProgramKey &k : s.sharpWarmKeys) {
            bool missing = false;
            sharpVariants(k, [&](ProgramKey v) {
                if (programs.count(v.bits()))
                    return;
                missing = true;
                if (work.links > 0 && mayWork())
                    startProgram(v);
            });
            if (missing && (work.links <= 0 || !mayWork()))
                return;
        }
        sharpWarmedSerial = s.serial;
    }

    /** Starts links for programs `s` does not draw yet (hidden objects, other materials) with links
     * left over. */
    void warm(const RenderState &s) {
        if (warmedSerial == s.serial)
            return;
        for (const ProgramKey &k : s.warmKeys) {
            bool missing = false;
            variants(k, [&](ProgramKey v) {
                if (programs.count(v.bits()))
                    return;
                missing = true;
                if (work.links > 0 && mayWork())
                    startProgram(v);
            });
            if (missing && (work.links <= 0 || !mayWork()))
                return;
        }
        warmedSerial = s.serial;
    }

    /** Deletes GL buffers whose model object is gone, and the vertex arrays that used them. */
    void sweep() {
        std::unordered_set<uint64_t> gone;
        for (auto it = buffers.begin(); it != buffers.end();) {
            if (!it->second.owner.expired()) {
                ++it;
                continue;
            }
            glDeleteBuffers(1, &it->second.id);
            gone.insert(it->first);
            it = buffers.erase(it);
        }
        if (gone.empty())
            return;
        for (auto it = vaos.begin(); it != vaos.end();) {
            const VaoEntry &v = it->second;
            if (gone.count(v.vertices) || gone.count(v.indices) || gone.count(v.instances)) {
                glDeleteVertexArrays(1, &v.id);
                it = vaos.erase(it);
            } else
                ++it;
        }
        gl.vao = ~0u;
    }

    /**
     * Points drawn as quads: one instance per point (its vertex attributes advance per instance)
     * and four strip vertices per instance from gl_VertexID (scene_shaders.cpp). Indexed points
     * stay GL points; ES 3.0 cannot index instance attributes.
     */
    static bool pointQuads(const DrawItem &it) {
        return it.mode == DrawMode::Points && !it.indices;
    }

    GLuint vao(const DrawItem &it) {
        uint64_t iv = it.indices ? it.indices->serial : 0,
                 in = it.instances ? it.instances->serial : 0;
        const bool quads = pointQuads(it);
        uint64_t key = mix64(mix64(mix64(it.vertices->serial, iv), in), it.useVertexColor);
        // A quad array starts at the draw's first point, since instanced draws cannot.
        if (quads)
            key = mix64(mix64(key, 0x9e3779b97f4a7c15ull), it.first);
        auto found = vaos.find(key);
        if (found != vaos.end())
            return found->second.id;
        GLuint v = 0;
        glGenVertexArrays(1, &v);
        glBindVertexArray(v);
        glBindBuffer(GL_ARRAY_BUFFER, buffers.at(it.vertices->serial).id);
        if (quads) {
            const size_t base = size_t(it.first) * kVertexStride;
            glEnableVertexAttribArray(kAttrPosition);
            glVertexAttribPointer(kAttrPosition, 3, GL_FLOAT, GL_FALSE, kVertexStride,
                                  offset(base + kOffsetPosition));
            glVertexAttribDivisor(kAttrPosition, 1);
            if (it.useVertexColor) {
                glEnableVertexAttribArray(kAttrColor);
                glVertexAttribPointer(kAttrColor, 4, GL_HALF_FLOAT, GL_FALSE, kVertexStride,
                                      offset(base + kOffsetColor));
                glVertexAttribDivisor(kAttrColor, 1);
            }
            vaos[key] = {v, it.vertices->serial, iv, in};
            gl.vao = v;
            return v;
        }
        glEnableVertexAttribArray(kAttrPosition);
        glVertexAttribPointer(kAttrPosition, 3, GL_FLOAT, GL_FALSE, kVertexStride,
                              offset(kOffsetPosition));
        if (it.vertices->normal) {
            glEnableVertexAttribArray(kAttrNormal);
            glVertexAttribPointer(kAttrNormal, 4, GL_INT_2_10_10_10_REV, GL_TRUE, kVertexStride,
                                  offset(kOffsetNormal));
        }
        if (it.vertices->uv) {
            glEnableVertexAttribArray(kAttrUv);
            glVertexAttribPointer(kAttrUv, 2, GL_FLOAT, GL_FALSE, kVertexStride, offset(kOffsetUv));
        }
        if (it.useVertexColor) {
            glEnableVertexAttribArray(kAttrColor);
            glVertexAttribPointer(kAttrColor, 4, GL_HALF_FLOAT, GL_FALSE, kVertexStride,
                                  offset(kOffsetColor));
        }
        if (it.instances) {
            glBindBuffer(GL_ARRAY_BUFFER, buffers.at(in).id);
            for (GLuint r = 0; r < 3; r++) {
                glEnableVertexAttribArray(kAttrInstance0 + r);
                glVertexAttribPointer(kAttrInstance0 + r, 4, GL_FLOAT, GL_FALSE, kInstanceStride,
                                      offset(r * 16));
                glVertexAttribDivisor(kAttrInstance0 + r, 1);
            }
            glEnableVertexAttribArray(kAttrInstanceColor);
            glVertexAttribPointer(kAttrInstanceColor, 3, GL_FLOAT, GL_FALSE, kInstanceStride,
                                  offset(48));
            glVertexAttribDivisor(kAttrInstanceColor, 1);
        }
        if (it.indices)
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, buffers.at(iv).id);
        vaos[key] = {v, it.vertices->serial, iv, in};
        gl.vao = v;
        return v;
    }

    // Current attribute values are context state (not vertex array state), so these hold for every
    // array a draw leaves disabled.
    static void setDefaultAttributes() {
        glVertexAttrib4f(kAttrNormal, 0, 0, 1, 0);
        glVertexAttrib4f(kAttrUv, 0, 0, 0, 0);
        glVertexAttrib4f(kAttrColor, 1, 1, 1, 1);
        glVertexAttrib4f(kAttrInstance0, 1, 0, 0, 0);
        glVertexAttrib4f(kAttrInstance1, 0, 1, 0, 0);
        glVertexAttrib4f(kAttrInstance2, 0, 0, 1, 0);
        glVertexAttrib4f(kAttrInstanceColor, 1, 1, 1, 1);
    }

    // ---- GL thread: textures --------------------------------------------------------------------

    void applySampler(GLuint tex, const TextureSlot &s) {
        glBindTexture(GL_TEXTURE_2D, tex);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GLint(s.wrapS));
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GLint(s.wrapT));
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GLint(s.mag));
        // Without mipmaps a mipmapped min filter would make the texture incomplete.
        GLint min = GLint(s.mips ? s.min
                                 : (s.min == GL_NEAREST || s.min == GL_NEAREST_MIPMAP_NEAREST ||
                                            s.min == GL_NEAREST_MIPMAP_LINEAR
                                        ? GL_NEAREST
                                        : GL_LINEAR));
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, min);
        if (maxAniso > 1)
            glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT,
                            std::max(1.0f, std::min(maxAniso, s.aniso)));
    }

    static void copySampler(const TextureOp &from, TextureOp &to) {
        to.wrapS = from.wrapS;
        to.wrapT = from.wrapT;
        to.mag = from.mag;
        to.min = from.min;
        to.aniso = from.aniso;
    }

    static TextureSlot slotOf(const TextureOp &op) {
        TextureSlot s;
        s.wrapS = op.wrapS;
        s.wrapT = op.wrapT;
        s.mag = op.mag;
        s.min = op.min;
        s.mips = op.mips;
        s.aniso = op.aniso;
        return s;
    }

    void deleteTexture(uint32_t id) {
        auto it = textures.find(id);
        if (it != textures.end()) {
            glDeleteTextures(1, &it->second.id);
            textures.erase(it);
        }
        for (auto j = jobs.begin(); j != jobs.end();) {
            if (j->op.id != id) {
                ++j;
                continue;
            }
            if (j->tex)
                glDeleteTextures(1, &j->tex);
            j = jobs.erase(j);
        }
    }

    void clearTextures() {
        for (auto &[id, t] : textures)
            glDeleteTextures(1, &t.id);
        textures.clear();
        for (auto &j : jobs)
            if (j.tex)
                glDeleteTextures(1, &j.tex);
        jobs.clear();
    }

    void takeTextureOps() {
        // Keep most uploads on the bridge side, where a newer image still replaces a waiting
        // one.
        std::deque<TextureOp> ops = stream.takeTextureOps(
            jobs.size(), size_t(std::max(1, options.textureUploadsPerFrame)) * 2);
        for (auto &op : ops) {
            switch (op.kind) {
            case TextureOp::Clear:
                clearTextures();
                break;
            case TextureOp::Remove:
                deleteTexture(op.id);
                break;
            case TextureOp::Sampler: {
                auto it = textures.find(op.id);
                if (it != textures.end()) {
                    TextureSlot s = slotOf(op);
                    s.id = it->second.id;
                    s.w = it->second.w;
                    s.h = it->second.h;
                    s.mips = it->second.mips; // mipmaps exist only if made at upload
                    applySampler(s.id, s);
                    it->second = s;
                }
                for (auto &j : jobs)
                    if (j.op.id == op.id)
                        copySampler(op, j.op);
                break;
            }
            case TextureOp::Upload: {
                auto same = std::find_if(jobs.begin(), jobs.end(),
                                         [&](const UploadJob &j) { return j.op.id == op.id; });
                if (same == jobs.end()) {
                    jobs.push_back({std::move(op), 0, 0});
                    break;
                }
                // Restart with the newer pixels; a different size or format needs a new object.
                const Image &a = same->op.image;
                if (same->tex && (a.w != op.image.w || a.h != op.image.h ||
                                  same->op.srgb != op.srgb || same->op.mips != op.mips)) {
                    glDeleteTextures(1, &same->tex);
                    same->tex = 0;
                }
                same->op = std::move(op);
                same->row = 0;
                break;
            }
            }
        }
    }

    /** Uploads texture rows within the budget, at most textureUploadsPerFrame new textures per
     * frame. */
    void pumpTextures() {
        takeTextureOps();
        int started = 0;
        glActiveTexture(GL_TEXTURE0);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
        for (auto j = jobs.begin(); j != jobs.end() && work.bytes > 0 && mayWork();) {
            UploadJob &job = *j;
            work.worked = true;
            const Image &img = job.op.image;
            if (img.w <= 0 || img.h <= 0) {
                j = jobs.erase(j);
                continue;
            }
            if (!job.tex) {
                if (started >= options.textureUploadsPerFrame)
                    break;
                started++;
                int levels = 1;
                if (job.op.mips)
                    for (int s = std::max(img.w, img.h); s > 1; s >>= 1)
                        levels++;
                glGenTextures(1, &job.tex);
                glBindTexture(GL_TEXTURE_2D, job.tex);
                glTexStorage2D(GL_TEXTURE_2D, levels, job.op.srgb ? GL_SRGB8_ALPHA8 : GL_RGBA8,
                               img.w, img.h);
            }
            size_t rowBytes = size_t(img.w) * 4;
            int rows = int(std::min<size_t>(size_t(img.h - job.row),
                                            std::max<size_t>(1, work.bytes / rowBytes)));
            glBindTexture(GL_TEXTURE_2D, job.tex);
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, job.row, img.w, rows, GL_RGBA, GL_UNSIGNED_BYTE,
                            img.rgba.data() + size_t(job.row) * rowBytes);
            job.row += rows;
            size_t sent = size_t(rows) * rowBytes;
            work.bytes -= std::min(work.bytes, sent);
            stats.uploadedBytesLastFrame += sent;
            if (job.row < img.h)
                break; // the rest next frame
            if (job.op.mips)
                glGenerateMipmap(GL_TEXTURE_2D);
            TextureSlot s = slotOf(job.op);
            s.id = job.tex;
            s.w = img.w;
            s.h = img.h;
            applySampler(s.id, s);
            auto old = textures.find(job.op.id);
            if (old != textures.end())
                glDeleteTextures(1, &old->second.id);
            textures[job.op.id] = s;
            j = jobs.erase(j);
        }
    }

    GLuint textureFor(uint32_t id, GLuint fallback) const {
        auto it = textures.find(id);
        return it == textures.end() ? fallback : it->second.id;
    }

    // ---- GL thread: draw state ------------------------------------------------------------------

    struct GlState {
        int blend = -1; // -1 unknown, 0 off, 1 on with `last`
        BlendState last;
        int cull = -1, frontCW = -1;
        int depthTest = -1, depthMask = -1, colorMask = -1;
        uint32_t depthFunc = 0;
        int polygonOffset = -1;
        float offsetFactor = 0, offsetUnits = 0;
        GLuint program = ~0u;
        GLuint vao = ~0u;
        GLuint bound[5] = {~0u, ~0u, ~0u, ~0u, ~0u};
    } gl;

    void disableBlend() {
        if (gl.blend != 0)
            glDisable(GL_BLEND);
        gl.blend = 0;
    }

    /** three's WebGLState.setBlending for the material's blending. */
    void setBlend(const MaterialState &m) {
        const BlendState &b = m.blend;
        if (b.mode == BlendMode::None || (b.mode == BlendMode::Normal && !m.transparent)) {
            disableBlend();
            return;
        }
        if (gl.blend == 1 && std::memcmp(&gl.last, &b, sizeof b) == 0)
            return;
        if (gl.blend != 1)
            glEnable(GL_BLEND);
        gl.blend = 1;
        gl.last = b;
        if (b.mode == BlendMode::Custom) {
            glBlendEquationSeparate(b.eq, b.eqAlpha);
            glBlendFuncSeparate(b.src, b.dst, b.srcAlpha, b.dstAlpha);
            return;
        }
        glBlendEquation(GL_FUNC_ADD);
        if (b.premultiplied) {
            switch (b.mode) {
            case BlendMode::Additive:
                glBlendFunc(GL_ONE, GL_ONE);
                break;
            case BlendMode::Subtractive:
                glBlendFuncSeparate(GL_ZERO, GL_ONE_MINUS_SRC_COLOR, GL_ZERO, GL_ONE);
                break;
            case BlendMode::Multiply:
                glBlendFuncSeparate(GL_ZERO, GL_SRC_COLOR, GL_ZERO, GL_SRC_ALPHA);
                break;
            default:
                glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
                break;
            }
        } else {
            switch (b.mode) {
            case BlendMode::Additive:
                glBlendFunc(GL_SRC_ALPHA, GL_ONE);
                break;
            case BlendMode::Subtractive:
                glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR);
                break;
            case BlendMode::Multiply:
                glBlendFunc(GL_ZERO, GL_SRC_COLOR);
                break;
            default:
                glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE,
                                    GL_ONE_MINUS_SRC_ALPHA);
                break;
            }
        }
    }

    /** three's setMaterial: cull back faces unless DoubleSide; front faces wind CW for BackSide xor
     * a mirrored matrix. */
    void setFaces(CullSide side, bool mirrored) {
        int cull = side == CullSide::Double ? 0 : 1;
        if (cull != gl.cull) {
            if (cull) {
                glEnable(GL_CULL_FACE);
                glCullFace(GL_BACK);
            } else
                glDisable(GL_CULL_FACE);
            gl.cull = cull;
        }
        int cw = (side == CullSide::Back) != mirrored ? 1 : 0;
        if (cw != gl.frontCW) {
            glFrontFace(cw ? GL_CW : GL_CCW);
            gl.frontCW = cw;
        }
    }

    void setDepth(bool test, bool mask, uint32_t func) {
        if (int(test) != gl.depthTest) {
            if (test)
                glEnable(GL_DEPTH_TEST);
            else
                glDisable(GL_DEPTH_TEST);
            gl.depthTest = test;
        }
        if (int(mask) != gl.depthMask) {
            glDepthMask(mask ? GL_TRUE : GL_FALSE);
            gl.depthMask = mask;
        }
        if (func != gl.depthFunc) {
            glDepthFunc(func);
            gl.depthFunc = func;
        }
    }

    void setColorMask(bool on) {
        if (int(on) == gl.colorMask)
            return;
        glColorMask(on, on, on, on);
        gl.colorMask = on;
    }

    void setPolygonOffset(bool on, float factor, float units) {
        if (int(on) != gl.polygonOffset) {
            if (on)
                glEnable(GL_POLYGON_OFFSET_FILL);
            else
                glDisable(GL_POLYGON_OFFSET_FILL);
            gl.polygonOffset = on;
        }
        if (on && (factor != gl.offsetFactor || units != gl.offsetUnits)) {
            glPolygonOffset(factor, units);
            gl.offsetFactor = factor;
            gl.offsetUnits = units;
        }
    }

    void useProgram(const Program &p) {
        if (gl.program == p.id)
            return;
        glUseProgram(p.id);
        gl.program = p.id;
    }

    void bindTexture(int unit, GLuint tex) {
        if (gl.bound[unit] == tex)
            return;
        glActiveTexture(GL_TEXTURE0 + GLenum(unit));
        glBindTexture(GL_TEXTURE_2D, tex);
        gl.bound[unit] = tex;
    }

    void submit(const DrawItem &it) {
        GLuint v = vao(it);
        if (v != gl.vao) {
            glBindVertexArray(v);
            gl.vao = v;
        }
        GLenum mode = GL_TRIANGLES;
        switch (it.mode) {
        case DrawMode::Lines:
            mode = GL_LINES;
            break;
        case DrawMode::LineStrip:
            mode = GL_LINE_STRIP;
            break;
        case DrawMode::LineLoop:
            mode = GL_LINE_LOOP;
            break;
        case DrawMode::Points:
            mode = GL_POINTS;
            break;
        default:
            break;
        }
        GLsizei instances = it.instances ? GLsizei(it.instances->count) : 1;
        if (pointQuads(it)) {
            glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, GLsizei(it.count));
            stats.drawCalls++;
            stats.points += it.count;
            return;
        }
        if (it.indices) {
            GLenum type = it.indices->wide ? GL_UNSIGNED_INT : GL_UNSIGNED_SHORT;
            const void *at = offset(size_t(it.first) * (it.indices->wide ? 4 : 2));
            if (it.instances)
                glDrawElementsInstanced(mode, GLsizei(it.count), type, at, instances);
            else
                glDrawElements(mode, GLsizei(it.count), type, at);
        } else if (it.instances) {
            glDrawArraysInstanced(mode, GLint(it.first), GLsizei(it.count), instances);
        } else {
            glDrawArrays(mode, GLint(it.first), GLsizei(it.count));
        }
        stats.drawCalls++;
        uint64_t n = uint64_t(it.count) * uint64_t(instances);
        if (mode == GL_TRIANGLES)
            stats.triangles += uint32_t(n / 3);
        else if (mode == GL_POINTS)
            stats.points += uint32_t(n);
        else
            stats.lines += uint32_t(mode == GL_LINES ? n / 2 : n);
    }

    // A map not on the GPU yet samples transparent black, as three's empty texture does; a missing
    // gradient map samples white.
    void bindMaps(const MaterialState &m, bool emissive) {
        if (m.map)
            bindTexture(kUnitMap, textureFor(m.map, clearTex));
        if (m.alphaMap)
            bindTexture(kUnitAlphaMap, textureFor(m.alphaMap, clearTex));
        if (emissive && m.emissiveMap)
            bindTexture(kUnitEmissiveMap, textureFor(m.emissiveMap, clearTex));
        if (emissive && m.gradientMap)
            bindTexture(kUnitGradientMap, textureFor(m.gradientMap, white));
    }

    void drawColor(const Draw &d) {
        const DrawItem &it = *d.item;
        const MaterialState &m = *it.material;
        useProgram(asProgram(d));
        setBlend(m);
        setFaces(it.side, it.mirrored);
        setDepth(m.depthTest, m.depthWrite, m.depthFunc);
        setColorMask(m.colorWrite);
        setPolygonOffset(m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits);
        drawWithUniforms(d);
    }

    /** The item's matrices, material uniforms and maps, then the draw (the program is in use). */
    void drawWithUniforms(const Draw &d) {
        const DrawItem &it = *d.item;
        const MaterialState &m = *it.material;
        const Program &p = asProgram(d);
        if (p.uModel >= 0)
            glUniformMatrix4fv(p.uModel, 1, GL_FALSE, it.model);
        setMat3(p.uNormalMatrix, it.normal);
        if (p.uColor >= 0)
            glUniform4fv(p.uColor, 1, m.color);
        if (p.uEmissive >= 0)
            glUniform3fv(p.uEmissive, 1, m.emissive);
        if (p.uAlphaTest >= 0)
            glUniform1f(p.uAlphaTest, m.alphaTest);
        setMat3(p.uMapTransform, m.mapTransform);
        setMat3(p.uAlphaMapTransform, m.alphaMapTransform);
        setMat3(p.uEmissiveMapTransform, m.emissiveMapTransform);
        if (p.uReceiveShadow >= 0)
            glUniform1f(p.uReceiveShadow, it.receiveShadow ? 1.0f : 0.0f);
        if (p.uPointSize >= 0)
            glUniform1f(p.uPointSize, m.pointSize * options.pointPixelScale);
        if (p.uPointQuad >= 0)
            glUniform1i(p.uPointQuad, pointQuads(it) ? 1 : 0);
        if (p.uSpriteCenter >= 0)
            glUniform2fv(p.uSpriteCenter, 1, it.spriteCenter);
        if (p.uSpriteRotation >= 0)
            glUniform1f(p.uSpriteRotation, m.rotation);
        if (p.uMetalRough >= 0)
            glUniform2f(p.uMetalRough, m.metalness, m.roughness);
        if (p.uSpecular >= 0)
            glUniform4fv(p.uSpecular, 1, m.specular);
        for (int i = 0; i < 5; i++)
            if (p.uSky[i] >= 0)
                glUniform4fv(p.uSky[i], 1, m.skyUniforms[i]);
        bindMaps(m, true);
        submit(it);
    }

    /** Whether the shadow pass draws `it` (three draws each mesh once, with the material's
     * shadowSide). */
    static bool castsShadow(const DrawItem &it) {
        if (!it.castShadow || it.mode != DrawMode::Triangles || it.key.model == ShadeModel::Sprite)
            return false;
        // The back-face half of a two-pass transparent draw.
        return !(it.side == CullSide::Back && it.material->side == CullSide::Double);
    }

    /** The moon's shadow map, redrawn only when a caster, the light or an alpha-tested caster's
     * texture changed. */
    void renderShadow(const RenderState &s) {
        ensureShadowMap(s.shadowMapSize);
        uint64_t hash = s.shadowHash;
        for (const DrawItem &it : s.items)
            if (it.depthKey.alphaTest && castsShadow(it)) {
                hash = mix64(hash, it.material->map ? textureFor(it.material->map, 0) : 0);
                hash =
                    mix64(hash, it.material->alphaMap ? textureFor(it.material->alphaMap, 0) : 0);
            }
        if (hash == shadowHash)
            return;
        shadowHash = hash;
        // The caller's framebuffers, viewport and scissor test are restored by prepareFrame.
        glBindFramebuffer(GL_FRAMEBUFFER, shadowFbo);
        glDisable(GL_SCISSOR_TEST);
        glViewport(0, 0, shadowSize, shadowSize);
        setColorMask(false);
        disableBlend();
        setDepth(true, true, GL_LEQUAL);
        setPolygonOffset(false, 0, 0);
        glClearDepthf(1);
        glClear(GL_DEPTH_BUFFER_BIT);
        Mat4 lvp;
        std::copy(s.lightViewProj, s.lightViewProj + 16, lvp.begin());
        Frustum light = Frustum::fromViewProj(lvp);
        bindTexture(kUnitShadowMap, fallbackShadow); // never the texture being written
        uint32_t before = stats.drawCalls;
        // three's shadow pass draws meshes, lines and points that cast; this draws the meshes.
        for (const DrawItem &it : s.items) {
            if (!castsShadow(it) || !light.intersects(it.sphere))
                continue;
            const Program *p = program(it.depthKey);
            if (!p || p->failed)
                continue;
            useProgram(*p);
            const MaterialState &m = *it.material;
            setFaces(m.shadowSide, it.mirrored);
            if (p->uLightViewProj >= 0)
                glUniformMatrix4fv(p->uLightViewProj, 1, GL_FALSE, s.lightViewProj);
            if (p->uModel >= 0)
                glUniformMatrix4fv(p->uModel, 1, GL_FALSE, it.model);
            if (p->uColor >= 0)
                glUniform4fv(p->uColor, 1, m.color);
            if (p->uAlphaTest >= 0)
                glUniform1f(p->uAlphaTest, m.alphaTest);
            setMat3(p->uMapTransform, m.mapTransform);
            setMat3(p->uAlphaMapTransform, m.alphaMapTransform);
            bindMaps(m, false);
            submit(it);
        }
        stats.shadowDrawCalls = stats.drawCalls - before;
        stats.shadowMapDraws = stats.shadowDrawCalls;
        stats.shadowRedraws++;
    }

    static Mat4 toMat(const float *m) {
        Mat4 r;
        std::copy(m, m + 16, r.begin());
        return r;
    }

    /** The per-state uniform blocks, once per frame (prepareFrame). */
    void writeStateUbos(const RenderState &s) {
        stateRing = (stateRing + 1) % kUboRing;
        glBindBuffer(GL_UNIFORM_BUFFER, frameUbo[stateRing]);
        glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof s.frame, &s.frame);
        glBindBuffer(GL_UNIFORM_BUFFER, skyUbo[stateRing]);
        glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof s.sky, &s.sky);
        glBindBuffer(GL_UNIFORM_BUFFER, 0);
    }

    /** The view blocks, per render call: two buffers, one per eye (single view) or both views in
     * each (multiview). */
    void writeViewUbos(const SceneEye *eyes, int count, int heightPx, bool multiviewPass) {
        ring = (ring + 1) % kUboRing;
        for (int e = 0; e < 2; e++) {
            ViewBlock v;
            for (int i = 0; i < 2; i++) {
                // Multiview: slot i is eye i. Single view: buffer e holds eye e in slot 0.
                const SceneEye &eye = eyes[multiviewPass ? i : std::min(e, count - 1)];
                Mat4 view = toMat(eye.view), proj = toMat(eye.projection);
                Mat4 vp = multiply(proj, view), inv;
                if (!invert(view, inv))
                    inv = identity();
                std::copy(vp.begin(), vp.end(), v.viewProj[i].m);
                std::copy(view.begin(), view.end(), v.view[i].m);
                std::copy(proj.begin(), proj.end(), v.proj[i].m);
                v.cameraPos[i] = {inv[12], inv[13], inv[14], 1};
            }
            v.viewport = {float(heightPx), float(heightPx) * 0.5f, 0, 0};
            glBindBuffer(GL_UNIFORM_BUFFER, viewUbo[ring][e]);
            glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof v, &v);
        }
        glBindBuffer(GL_UNIFORM_BUFFER, 0);
        // The caller may have rebound these between prepareFrame and now.
        glBindBufferBase(GL_UNIFORM_BUFFER, kBlockFrame, frameUbo[stateRing]);
        glBindBufferBase(GL_UNIFORM_BUFFER, kBlockSky, skyUbo[stateRing]);
        glBindBufferBase(GL_UNIFORM_BUFFER, kBlockView, viewUbo[ring][0]);
    }

    void setControllerPoses(const SceneControllerPoses &poses) {
        frame.setControllerPoses(poses, current.get());
    }

    /**
     * Takes the newest published state and draws it once its buffers and programs are on the GPU.
     * The first state also waits (up to 3 s) for its textures, so the world does not appear black.
     */
    void adopt() {
        {
            std::shared_ptr<const RenderState> latest = stream.latest();
            uint64_t have = pending ? pending->serial : current ? current->serial : 0;
            if (latest && latest->serial > have) {
                if (!pending)
                    pendingSince = seconds();
                pending = std::move(latest);
            }
        }
        if (!pending)
            return;
        if (!prepare(*pending))
            return;
        if (!current && !texturesResident(*pending) && seconds() - pendingSince < 3.0)
            return;
        current = std::move(pending);
        pending.reset();
        // Before sweep: the previous state's attached copies must not keep its buffers alive.
        frame.syncAttachments(*current);
        sweep();
        // Vertex arrays now, so the eye passes only look them up.
        for (const DrawItem &it : current->items)
            vao(it);
        glBindVertexArray(0);
        gl.vao = 0;
    }

    // ---- GL thread: GPU timer -------------------------------------------------------------------
    // A measured frame times prepareFrame and each render call with its own query and adds them up,
    // so the caller's own work between them is not counted.

    // prepareFrame, two eye passes and two screen layer passes.
    static constexpr int kTimed = 2, kQueries = 6;
    struct TimedFrame {
        GLuint q[kQueries] = {};
        int used = 0;
        bool active = false;
    } timed[kTimed];
    int timedSlot = -1; // the measured frame being recorded, -1 when this frame is not measured
    bool timing = false;

    void readTimers() {
        for (int i = 0; i < kTimed; i++) {
            TimedFrame &t = timed[i];
            if (!t.active || i == timedSlot)
                continue;
            GLuint total = 0;
            bool done = true;
            for (int k = 0; k < t.used && done; k++) {
                GLuint available = 0;
                glGetQueryObjectuiv(t.q[k], GL_QUERY_RESULT_AVAILABLE, &available);
                if (!available)
                    done = false;
            }
            if (!done)
                continue;
            for (int k = 0; k < t.used; k++) {
                GLuint ns = 0;
                glGetQueryObjectuiv(t.q[k], GL_QUERY_RESULT, &ns);
                total += ns;
            }
            GLint disjoint = 0;
            glGetIntegerv(GL_GPU_DISJOINT_EXT, &disjoint);
            if (!disjoint && t.used > 0)
                gpuMs = float(total) / 1e6f;
            t.active = false;
        }
    }

    void chooseTimedFrame() {
        timedSlot = -1;
        if (!options.gpuTimer || !timerSupported)
            return;
        int interval = std::max(1, options.gpuTimerInterval);
        if (frameNumber % uint64_t(interval) != 1 % uint64_t(interval))
            return;
        for (int i = 0; i < kTimed; i++)
            if (!timed[i].active) {
                timed[i].active = true;
                timed[i].used = 0;
                timedSlot = i;
                return;
            }
    }

    void beginTimed() {
        if (timedSlot < 0 || timing || timed[timedSlot].used >= kQueries)
            return;
        glBeginQuery(GL_TIME_ELAPSED_EXT, timed[timedSlot].q[timed[timedSlot].used]);
        timing = true;
    }

    void endTimed() {
        if (!timing)
            return;
        glEndQuery(GL_TIME_ELAPSED_EXT);
        timed[timedSlot].used++;
        timing = false;
    }

    // ---- GL thread: frame -----------------------------------------------------------------------

    void checkErrors(const char *where) {
        if (!options.checkGlErrors)
            return;
        for (GLenum err; (err = glGetError()) != GL_NO_ERROR;) {
            char buf[64];
            std::snprintf(buf, sizeof buf, "GL error 0x%04x in %s", unsigned(err), where);
            fail(buf);
        }
    }

    void clearTarget(const RenderState *s) {
        float c[3] = {0, 0, 0};
        if (s && s->hasBackground)
            for (int i = 0; i < 3; i++)
                c[i] = options.srgbFramebuffer ? s->background[i] : srgbEncode(s->background[i]);
        setColorMask(true);
        if (gl.depthMask != 1) {
            glDepthMask(GL_TRUE);
            gl.depthMask = 1;
        }
        glClearColor(c[0], c[1], c[2], 1);
        glClearDepthf(1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    }

    /** Closes the previous frame's CPU accounting and starts a new frame. */
    void beginFrame() {
        if (frameNumber > 0) {
            windowMax = std::max(windowMax, prepareMs + drawMs);
            if (++windowFrames >= 90) {
                cpuMaxMs = windowMax;
                windowMax = 0;
                windowFrames = 0;
                cpuWindowDone = true;
            }
        }
        frameNumber++;
        // Grips are valid for one display frame only.
        frame.beginFrame();
        prepareMs = drawMs = 0;
        stats.drawCalls = stats.shadowDrawCalls = stats.triangles = stats.points = stats.lines =
            stats.culledItems = 0;
        stats.uploadedBytesLastFrame = 0;
        stats.sharpScreens = stats.sharpOverlays = stats.sharpDrawCalls = 0;
        stats.sharpViewPixels = stats.sharpRegionPixels = 0;
        stats.sharpMs = 0;
        if (usedMultiview)
            wantMultiview = true;
        if (usedSingle)
            wantSingle = true;
        usedMultiview = usedSingle = false;
    }

    void prepareFrame() {
        auto t0 = Clock::now();
        beginFrame();
        prepared = true;
        GLint drawFbo = 0, readFbo = 0, viewport[4] = {};
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawFbo);
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readFbo);
        glGetIntegerv(GL_VIEWPORT, viewport);
        GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST);
        timedSlot = -1;
        readTimers();
        chooseTimedFrame();
        beginTimed();

        work.start(t0, options.uploadBytesPerFrame, options.programLinksPerFrame,
                   options.prepareBudgetMs);
        gl = GlState{};
        setDefaultAttributes();
        // Geometry first: a state waits for its buffers, while textures may arrive a little later.
        pollPrograms();
        adopt();
        pumpTextures();
        const RenderState *s = current.get();
        if (pending)
            warm(*pending);
        if (s)
            warm(*s);
        if (pending)
            warmSharp(*pending);
        if (s)
            warmSharp(*s);
        if (s && s->shadow && options.shadows && s->shadowMapSize > 0)
            renderShadow(*s);
        if (s)
            writeStateUbos(*s);

        endTimed();
        restoreState();
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawFbo));
        glBindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(readFbo));
        glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
        if (scissor)
            glEnable(GL_SCISSOR_TEST);
        checkErrors("prepareFrame");
        prepareMs = std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
    }

    void draw(const SceneEye *eyes, int count, int heightPx,
              const std::function<void(int)> &bindEye) {
        if (autoPrepare || !prepared)
            prepareFrame();
        auto t0 = Clock::now();
        bool multiviewPass = count == 2 && options.multiview;
        (multiviewPass ? usedMultiview : usedSingle) = true;
        drawing = true;
        beginTimed();
        // The caller may have changed any state since prepareFrame.
        gl = GlState{};
        setDefaultAttributes();
        const RenderState *s = current.get();
        if (s) {
            writeViewUbos(eyes, count, heightPx, multiviewPass);
            frame.buildLists(*s, eyes, count, multiviewPass, *this);
            stats.attachedPlaced = frame.attachedPlaced();
            stats.culledItems = frame.culledItems();
        }
        int passes = multiviewPass ? 1 : count;
        for (int e = 0; e < passes; e++) {
            if (count == 2 && !multiviewPass && bindEye) {
                bindEye(e);
                gl = GlState{}; // the callback may touch any state
            }
            if (s && !multiviewPass)
                glBindBufferBase(GL_UNIFORM_BUFFER, kBlockView, viewUbo[ring][e]);
            if (options.clear)
                clearTarget(s);
            if (!s)
                continue;
            bindTexture(kUnitShadowMap,
                        shadowTex && s->shadow && options.shadows ? shadowTex : fallbackShadow);
            for (const Draw &d : frame.opaque())
                drawColor(d);
            for (const Draw &d : frame.transparent())
                drawColor(d);
        }
        endTimed();
        restoreState();
        drawing = false;
        checkErrors("render");
        drawMs += std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
    }

    // ---- GL thread: the high-resolution screen layer --------------------------------------------

    /** A linked program for `key`, else null. Never starts or advances a build. */
    const Program *readyProgram(const ProgramKey &key) const {
        auto it = programs.find(key.bits());
        return it != programs.end() && it->second.ready ? &it->second : nullptr;
    }

    void setSharpUniforms(const Program &p, const SharpScreenDepth &depth, int w, int h, float fade,
                          bool multiviewPass) {
        if (p.uSharpRect >= 0)
            glUniform4fv(p.uSharpRect, 1, depth.uvRect);
        if (p.uSharpParams >= 0)
            glUniform4f(p.uSharpParams, 1.0f / float(w), 1.0f / float(h), options.sharpDepthSlack,
                        1.0f - std::max(0.0f, std::min(1.0f, fade)));
        if (p.uSharpBias >= 0)
            glUniform4f(p.uSharpBias, kSharpBiasMeters, options.sharpMaxSlopeMeters,
                        multiviewPass ? 0.0f : float(depth.layer), kSharpBiasPerMeter);
    }

    // The screen occlusion test's fixed slack: a few millimetres plus a small share of the
    // distance, well under the thickness of anything that can sit in front of a laptop screen.
    static constexpr float kSharpBiasMeters = 0.003f, kSharpBiasPerMeter = 0.001f;

    bool hasSharp(const SceneEye *eyes, bool arrayDepth) const {
        const RenderState *s = current.get();
        if (!initialized || !s || !s->sharpItems)
            return false;
        return frame.hasSharp(*s, eyes, arrayDepth, *this);
    }

    bool hasSharpAnywhere() const {
        const RenderState *s = current.get();
        if (!initialized || !s || !s->sharpItems)
            return false;
        return frame.hasSharpAnywhere(*s, *this);
    }

    /** Plans this frame's screen layer; see SceneRenderer::planSharpScreens. */
    bool planSharp(const SceneEye *eyes, const int *w, const int *h, bool arrayDepth,
                   SharpScreenPlan &plan) {
        auto t0 = Clock::now();
        frame.planSharp(current, initialized, frameNumber, eyes, w, h, arrayDepth, plan, *this);
        if (plan.any)
            for (const int *r : plan.viewRect)
                stats.sharpViewPixels += uint64_t(r[2]) * uint64_t(r[3]);
        stats.sharpMs += std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
        return plan.any;
    }

    /** Saved and restored around a screen layer call. */
    struct CallerState {
        GLboolean scissor = GL_FALSE;
        GLint box[4] = {}, viewport[4] = {};
        static CallerState now() {
            CallerState c;
            c.scissor = glIsEnabled(GL_SCISSOR_TEST);
            glGetIntegerv(GL_SCISSOR_BOX, c.box);
            glGetIntegerv(GL_VIEWPORT, c.viewport);
            return c;
        }
        Rect scissorRect() const { return {box[0], box[1], box[0] + box[2], box[1] + box[3]}; }
        void restore() const {
            if (scissor)
                glEnable(GL_SCISSOR_TEST);
            else
                glDisable(GL_SCISSOR_TEST);
            glScissor(box[0], box[1], box[2], box[3]);
            glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
        }
    };

    static void scissorTo(const Rect &r) {
        glEnable(GL_SCISSOR_TEST);
        glScissor(r.x0, r.y0, std::max(0, r.x1 - r.x0), std::max(0, r.y1 - r.y0));
    }

    /** Leaves the render() state after a screen layer call and closes its accounting. */
    void finishSharp(Clock::time_point t0, uint32_t drawCalls, uint32_t triangles,
                     const CallerState &caller) {
        uint32_t issued = stats.drawCalls - drawCalls;
        stats.drawCalls = drawCalls;
        stats.triangles = triangles;
        stats.sharpDrawCalls += issued;
        glActiveTexture(GL_TEXTURE0 + kUnitSharpDepth);
        glBindTexture(GL_TEXTURE_2D, 0);
        glBindTexture(GL_TEXTURE_2D_ARRAY, 0);
        glBindSampler(kUnitSharpDepth, 0);
        restoreState();
        caller.restore();
        checkErrors("renderSharpScreens");
        stats.sharpMs += std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
    }

    bool sharpDepthUsable(const SharpScreenDepth &depth, bool multiviewPass) {
        if (multiviewPass && !depth.arrayTexture && !sharpDepthKindReported) {
            sharpDepthKindReported = true;
            fail("renderSharpScreens: multiview needs the world depth as a 2-layer array texture");
        }
        return depth.texture && (!multiviewPass || depth.arrayTexture);
    }

    /** The whole-image layer: see the first SceneRenderer::renderSharpScreens. */
    void drawSharp(const SceneEye *eyes, int w, int h, const SharpScreenDepth &depth, float fade) {
        auto t0 = Clock::now();
        const bool multiviewPass = options.multiview;
        const int count = multiviewPass ? 2 : 1;
        const CallerState caller = CallerState::now();
        gl = GlState{};
        setColorMask(true);
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT);
        const RenderState *s = current.get();
        bool usable =
            sharpDepthUsable(depth, multiviewPass) && s && s->sharpItems && w > 0 && h > 0;
        uint32_t drawCalls = stats.drawCalls, triangles = stats.triangles;
        frame.forgetPlan(); // the lists below replace a plan's
        if (usable) {
            SharpView views[2] = {sharpView(eyes[0]), sharpView(eyes[multiviewPass ? 1 : 0])};
            SharpDepth kind = depth.arrayTexture ? SharpDepth::Array : SharpDepth::Texture2D;
            const int ws[2] = {w, w}, hs[2] = {h, h};
            Rect cover[2];
            if (frame.selectSharp(*s, views, count, kind, multiviewPass, ws, hs, cover, *this)) {
                Rect draw = unite(cover[0], cover[1]);
                if (caller.scissor)
                    draw = intersect(draw, caller.scissorRect());
                drawing = true;
                beginTimed();
                setDefaultAttributes();
                drawSharpPass(eyes, count, *s, kind, w, h, depth, fade, multiviewPass, 3, draw);
                endTimed();
                drawing = false;
            }
        }
        finishSharp(t0, drawCalls, triangles, caller);
    }

    /** The planned layer: see the second SceneRenderer::renderSharpScreens. */
    void drawSharpPlan(const SharpScreenPlan &plan, int view, const SharpScreenDepth &depth,
                       float fade) {
        auto t0 = Clock::now();
        const bool multiviewPass = options.multiview;
        const int v = multiviewPass ? 0 : std::max(0, std::min(1, view));
        const CallerState caller = CallerState::now();
        gl = GlState{};
        setColorMask(true);
        const bool current_ = frame.planIsCurrent(plan, frameNumber, current);
        if (plan.any && !current_ && !sharpPlanReported) {
            sharpPlanReported = true;
            fail("renderSharpScreens: the plan is not this frame's latest planSharpScreens");
        }
        const int w = std::max(0, plan.width[v]), h = std::max(0, plan.height[v]);
        const int *pr = plan.region[v];
        Rect region{pr[0], pr[1], pr[0] + pr[2], pr[1] + pr[3]};
        if (caller.scissor)
            region = intersect(region, caller.scissorRect());
        uint32_t drawCalls = stats.drawCalls, triangles = stats.triangles;
        if (!region.empty() && w > 0 && h > 0) {
            glViewport(0, 0, w, h);
            // Only the region is ever presented: nothing else needs loading or storing.
            GLint fbo = 0;
            glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
            const GLenum color = fbo ? GL_COLOR_ATTACHMENT0 : GL_COLOR;
            glInvalidateFramebuffer(GL_DRAW_FRAMEBUFFER, 1, &color);
            scissorTo(region);
            glClearColor(0, 0, 0, 0);
            glClear(GL_COLOR_BUFFER_BIT);
            stats.sharpRegionPixels += uint64_t(region.x1 - region.x0) *
                                       uint64_t(region.y1 - region.y0) * (multiviewPass ? 2u : 1u);
        }
        const RenderState *s = current.get();
        bool usable = current_ && !region.empty() && sharpDepthUsable(depth, multiviewPass) &&
                      depth.arrayTexture == plan.arrayDepth && s && w > 0 && h > 0;
        if (usable) {
            // Screens and overlays stay inside the presented pixels; the guard band stays clear.
            Rect draw;
            for (int i = 0; i < (multiviewPass ? 2 : 1); i++) {
                const int *r = plan.viewRect[multiviewPass ? i : v];
                draw = unite(draw, {r[0], r[1], r[0] + r[2], r[1] + r[3]});
            }
            draw = intersect(draw, region);
            const SceneEye eyes[2] = {plan.eyes[v], plan.eyes[1]};
            drawing = true;
            beginTimed();
            setDefaultAttributes();
            drawSharpPass(eyes, multiviewPass ? 2 : 1, *s,
                          plan.arrayDepth ? SharpDepth::Array : SharpDepth::Texture2D, w, h, depth,
                          fade, multiviewPass, multiviewPass ? 3 : uint8_t(1u << v), draw);
            endTimed();
            drawing = false;
        }
        finishSharp(t0, drawCalls, triangles, caller);
    }

    /**
     * Draws sharpScreens, then sharpOverlays, that a view in `viewBits` sees, inside `scissor`.
     * The target is already cleared.
     */
    void drawSharpPass(const SceneEye *eyes, int count, const RenderState &s, SharpDepth kind,
                       int w, int h, const SharpScreenDepth &depth, float fade, bool multiviewPass,
                       uint8_t viewBits, const Rect &scissor) {
        if (scissor.empty())
            return;
        writeViewUbos(eyes, count, h, multiviewPass);
        glActiveTexture(GL_TEXTURE0 + kUnitSharpDepth);
        glBindTexture(kind == SharpDepth::Array ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D,
                      depth.texture);
        glBindSampler(kUnitSharpDepth, sharpSampler);
        bindTexture(kUnitShadowMap,
                    shadowTex && s.shadow && options.shadows ? shadowTex : fallbackShadow);
        scissorTo(scissor);

        // Screens: opaque, over the cleared layer, kept only where the world depth shows them.
        disableBlend();
        setDepth(false, false, GL_LEQUAL);
        setPolygonOffset(false, 0, 0);
        for (const Draw &d : frame.sharpScreens()) {
            if (!(d.views & viewBits))
                continue;
            const DrawItem &it = *d.item;
            useProgram(asProgram(d));
            setSharpUniforms(asProgram(d), depth, w, h, fade, multiviewPass);
            setFaces(it.side, it.mirrored);
            drawWithUniforms(d);
            stats.sharpScreens++;
        }

        // See-through surfaces in front of a screen, only inside the screens' pixels. Weighted by
        // destination alpha, so only screen pixels change and alpha stays 1 there:
        // screen * (1 - a) + color * a for normal blending, screen + color * a for additive.
        bool blending = false;
        for (const Draw &d : frame.sharpOverlays()) {
            if (!(d.views & viewBits))
                continue;
            if (!blending) {
                glEnable(GL_BLEND);
                gl.blend = -1;
                glBlendEquation(GL_FUNC_ADD);
                blending = true;
            }
            const DrawItem &it = *d.item;
            bool additive = it.material->blend.mode == BlendMode::Additive;
            glBlendFuncSeparate(GL_DST_ALPHA, additive ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA, GL_ZERO,
                                GL_ONE);
            useProgram(asProgram(d));
            setSharpUniforms(asProgram(d), depth, w, h, fade, multiviewPass);
            setFaces(it.side, it.mirrored);
            drawWithUniforms(d);
            stats.sharpOverlays++;
        }
    }

    void publishStats() {
        const RenderState *s = current.get();
        stats.prepareMs = prepareMs;
        stats.drawMs = drawMs;
        stats.cpuMs = prepareMs + drawMs;
        stats.cpuMaxMs = cpuWindowDone ? cpuMaxMs : std::max(windowMax, stats.cpuMs);
        stats.gpuMs = gpuMs;
        stats.pendingUploads = uint32_t(jobs.size());
        stats.waitingState = pending != nullptr;
        stats.drawItems = s ? uint32_t(s->items.size()) : 0;
        if (s) {
            stats.objects = s->objects;
            stats.visibleObjects = s->visibleObjects;
            stats.staticBatches = s->staticBatches;
            stats.batchedObjects = s->batchedObjects;
            stats.dynamicObjects = s->dynamicObjects;
            stats.geometries = s->geometries;
            stats.materials = s->materialCount;
            stats.unsupported = s->unsupported;
            stats.stateSerial = s->serial;
            stats.sharpItems = s->sharpItems;
            stats.attachedItems = s->attachedItems;
        }
        stats.textures = uint32_t(textures.size());
        stats.programs = uint32_t(programs.size());
        stats.programsCompiling = uint32_t(compiling.size());
        stats.programsFailed = programsFailed;
        stats.buffers = uint32_t(buffers.size());
        stats.vertexArrays = uint32_t(vaos.size());
        std::lock_guard<std::mutex> lock(statsMutex);
        frameStats = stats;
    }

    /** The GL state prepareFrame and render leave, documented in scene_renderer.h. */
    static void restoreState() {
        glBindVertexArray(0);
        glUseProgram(0);
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glBindBuffer(GL_UNIFORM_BUFFER, 0);
        glDisable(GL_BLEND);
        glDisable(GL_CULL_FACE);
        glDisable(GL_POLYGON_OFFSET_FILL);
        glEnable(GL_DEPTH_TEST);
        glDepthMask(GL_TRUE);
        glDepthFunc(GL_LEQUAL);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glFrontFace(GL_CCW);
        glActiveTexture(GL_TEXTURE0);
    }

    void destroy() {
        if (!initialized)
            return;
        if (timing)
            glEndQuery(GL_TIME_ELAPSED_EXT);
        for (auto &[k, b] : buffers)
            glDeleteBuffers(1, &b.id);
        for (auto &[k, v] : vaos)
            glDeleteVertexArrays(1, &v.id);
        for (auto &[k, p] : programs) {
            if (p.vs)
                glDeleteShader(p.vs);
            if (p.fs)
                glDeleteShader(p.fs);
            if (p.id)
                glDeleteProgram(p.id);
        }
        clearTextures();
        GLuint tex[] = {white, clearTex, fallbackShadow, shadowTex};
        glDeleteTextures(4, tex);
        if (shadowFbo)
            glDeleteFramebuffers(1, &shadowFbo);
        if (sharpSampler)
            glDeleteSamplers(1, &sharpSampler);
        sharpSampler = 0;
        for (int i = 0; i < kUboRing; i++) {
            glDeleteBuffers(2, viewUbo[i]);
            glDeleteBuffers(1, &frameUbo[i]);
            glDeleteBuffers(1, &skyUbo[i]);
        }
        if (timerSupported)
            for (auto &t : timed)
                glDeleteQueries(kQueries, t.q);
        buffers.clear();
        vaos.clear();
        programs.clear();
        compiling.clear();
        initialized = false;
    }

    bool init() {
        if (initialized)
            return true;
        if (options.multiview && !hasExtension("GL_OVR_multiview2")) {
            fail("GL_OVR_multiview2 is not supported");
            return false;
        }
        wantMultiview = options.multiview;
        wantSingle = !options.multiview;
        timerSupported = hasExtension("GL_EXT_disjoint_timer_query");
        parallelCompile = hasExtension("GL_KHR_parallel_shader_compile");
        if (parallelCompile) {
            // The initial thread count is implementation-defined (0 on some drivers, which compiles
            // synchronously); ask for as many as the driver likes.
            auto threads = reinterpret_cast<MaxShaderCompilerThreadsFn>(
                eglGetProcAddress("glMaxShaderCompilerThreadsKHR"));
            if (threads)
                threads(0xFFFFFFFFu);
        }
        if (hasExtension("GL_EXT_texture_filter_anisotropic"))
            glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, &maxAniso);
        const uint8_t on[4] = {255, 255, 255, 255}, off[4] = {0, 0, 0, 0};
        glActiveTexture(GL_TEXTURE0);
        white = makeTexture(on);
        clearTex = makeTexture(off);
        // A lit 1x1 depth texture for programs that sample the shadow map while none is drawn.
        glGenTextures(1, &fallbackShadow);
        glBindTexture(GL_TEXTURE_2D, fallbackShadow);
        const uint32_t far = 0xffffffffu;
        glTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT24, 1, 1, 0, GL_DEPTH_COMPONENT,
                     GL_UNSIGNED_INT, &far);
        depthParams();
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenSamplers(1, &sharpSampler);
        glSamplerParameteri(sharpSampler, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glSamplerParameteri(sharpSampler, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glSamplerParameteri(sharpSampler, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glSamplerParameteri(sharpSampler, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glSamplerParameteri(sharpSampler, GL_TEXTURE_COMPARE_MODE, GL_NONE);
        for (int i = 0; i < kUboRing; i++) {
            glGenBuffers(2, viewUbo[i]);
            glGenBuffers(1, &frameUbo[i]);
            glGenBuffers(1, &skyUbo[i]);
            for (GLuint b : viewUbo[i]) {
                glBindBuffer(GL_UNIFORM_BUFFER, b);
                glBufferData(GL_UNIFORM_BUFFER, sizeof(ViewBlock), nullptr, GL_DYNAMIC_DRAW);
            }
            glBindBuffer(GL_UNIFORM_BUFFER, frameUbo[i]);
            glBufferData(GL_UNIFORM_BUFFER, sizeof(FrameBlock), nullptr, GL_DYNAMIC_DRAW);
            glBindBuffer(GL_UNIFORM_BUFFER, skyUbo[i]);
            glBufferData(GL_UNIFORM_BUFFER, sizeof(SkyBlock), nullptr, GL_DYNAMIC_DRAW);
        }
        glBindBuffer(GL_UNIFORM_BUFFER, 0);
        if (timerSupported)
            for (auto &t : timed)
                glGenQueries(kQueries, t.q);
        GLenum err = glGetError();
        if (err != GL_NO_ERROR) {
            fail("GL error " + std::to_string(err) + " while setting up the scene renderer");
            return false;
        }
        initialized = true;
        SCENE_LOG("scene renderer ready: multiview=%d timer=%d parallelCompile=%d anisotropy=%.0f",
                  int(options.multiview), int(timerSupported), int(parallelCompile),
                  double(maxAniso));
        return true;
    }
};

// ---- Public API
// -------------------------------------------------------------------------------------

SceneRenderer::SceneRenderer(const SceneRendererOptions &options)
    : impl_(std::make_unique<Impl>(options)) {}

SceneRenderer::~SceneRenderer() { impl_->destroy(); }

bool SceneRenderer::initialize() { return impl_->init(); }

bool SceneRenderer::enqueueJson(std::string_view text) { return impl_->stream.enqueueJson(text); }

bool SceneRenderer::enqueue(nlohmann::json &&j) { return impl_->stream.enqueue(std::move(j)); }

void SceneRenderer::tick() { impl_->stream.tick(); }

bool SceneRenderer::acceptsPackets() const { return impl_->stream.acceptsPackets(); }

bool SceneRenderer::takeResetRequest() { return impl_->stream.takeResetRequest(); }

void SceneRenderer::prepareFrame() {
    if (!impl_->initialized)
        return;
    impl_->autoPrepare = false;
    impl_->prepareFrame();
}

void SceneRenderer::setControllerPoses(const SceneControllerPoses &poses) {
    if (impl_->initialized)
        impl_->setControllerPoses(poses);
}

void SceneRenderer::render(const SceneEye &eye, int viewportHeightPx) {
    if (impl_->initialized)
        impl_->draw(&eye, 1, viewportHeightPx, {});
}

void SceneRenderer::renderStereo(const SceneEye eyes[2], int viewportHeightPx,
                                 const std::function<void(int eye)> &bindEye) {
    if (impl_->initialized)
        impl_->draw(eyes, 2, viewportHeightPx, bindEye);
}

bool SceneRenderer::hasSharpScreens() const { return impl_->hasSharpAnywhere(); }

bool SceneRenderer::hasSharpScreens(const SceneEye eyes[2], bool arrayDepth) const {
    return impl_->hasSharp(eyes, arrayDepth);
}

void SceneRenderer::renderSharpScreens(const SceneEye eyes[2], int viewportWidth,
                                       int viewportHeight, const SharpScreenDepth &depth,
                                       float fade) {
    if (impl_->initialized)
        impl_->drawSharp(eyes, viewportWidth, viewportHeight, depth, fade);
}

bool SceneRenderer::planSharpScreens(const SceneEye eyes[2], const int width[2],
                                     const int height[2], bool arrayDepth, SharpScreenPlan &plan) {
    return impl_->planSharp(eyes, width, height, arrayDepth, plan);
}

void SceneRenderer::renderSharpScreens(const SharpScreenPlan &plan, int view,
                                       const SharpScreenDepth &depth, float fade) {
    if (impl_->initialized)
        impl_->drawSharpPlan(plan, view, depth, fade);
}

bool SceneRenderer::cameraWorld(float out[16]) const { return impl_->stream.cameraWorld(out); }

SceneStats SceneRenderer::stats() const {
    const Impl &s = *impl_;
    SceneStats st;
    {
        std::lock_guard<std::mutex> lock(s.statsMutex);
        st = s.frameStats;
    }
    const SceneStreamStats bridge = s.stream.stats();
    st.queuedTextureOps = bridge.queuedTextureOps;
    st.queuedBytes = bridge.queuedBytes;
    st.packetsApplied = bridge.packetsApplied;
    st.packetsRejected = bridge.packetsRejected;
    st.commits = bridge.commits;
    st.sceneSeq = bridge.sceneSeq;
    st.parseMs = bridge.parseMs;
    st.applyMs = bridge.applyMs;
    st.applyMaxMs = bridge.applyMaxMs;
    return st;
}

std::string SceneRenderer::lastError() const { return impl_->stream.lastError(); }

} // namespace office
