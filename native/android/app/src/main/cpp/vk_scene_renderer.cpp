#include "vk_scene_renderer.h"

#include "scene_model.h"
#include "scene_stream.h"
#include "vk_memory.h"
#include "vk_scene_state.h"
#include "vk_shader_compiler.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

#ifdef __ANDROID__
#include <android/log.h>
#include <sys/resource.h>
#define VK_SCENE_LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeScene", __VA_ARGS__)
#else
#define VK_SCENE_LOG(...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))
#endif

// Every call and structure below follows one of these normative or working sources:
//  [VK]       The Vulkan 1.1 specification (docs.vulkan.org/spec): Render Pass, Pipelines,
//             Copy Commands, Synchronization and Cache Control, Descriptor Sets, Queries.
//  [VK-SYNC]  Khronos "Synchronization Examples" (github.com/KhronosGroup/Vulkan-Docs/wiki):
//             staging upload then sample, render to a depth image then sample it.
//  [VK-MIP]   Khronos Vulkan-Samples "texture_mipmap_generation" (vkCmdBlitImage chain).
//  [NDK-DN]   Android "Vulkan design guidelines": descriptor sets by update frequency.
//  [NDK-SC]   Android "Vulkan shader compilers on Android": libshaderc at runtime.
//  [VMA]      Vulkan Memory Allocator 3.1.0 "Recommended usage patterns" (GPU-only resources,
//             persistently mapped staging and uniform buffers).
//  [GD-RDV]   Godot drivers/vulkan/rendering_device_driver_vulkan.cpp @084a2ca (pipeline cache
//             header validation, dynamic uniform buffers, render pass dependencies).
//  [HXR]      Khronos hello_xr graphicsplugin_vulkan.cpp (pipeline, vertex input, viewport).
// The GL behaviour each part reproduces is the GLES SceneRenderer's (scene_renderer.cpp), named
// after its function there.

namespace office {

using namespace office::scene;
using namespace office::vkscene;
using Clock = std::chrono::steady_clock;

// vk_scene_state.h keeps the Vulkan values as numbers so its tables are host-testable without
// Vulkan; these are the header's own values.
static_assert(vkv::kCompareLessOrEqual == VK_COMPARE_OP_LESS_OR_EQUAL &&
                  vkv::kCompareAlways == VK_COMPARE_OP_ALWAYS &&
                  vkv::kCompareNever == VK_COMPARE_OP_NEVER &&
                  vkv::kCompareGreaterOrEqual == VK_COMPARE_OP_GREATER_OR_EQUAL,
              "VkCompareOp");
static_assert(vkv::kSrcAlpha == VK_BLEND_FACTOR_SRC_ALPHA &&
                  vkv::kOneMinusSrcAlpha == VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA &&
                  vkv::kDstColor == VK_BLEND_FACTOR_DST_COLOR &&
                  vkv::kDstAlpha == VK_BLEND_FACTOR_DST_ALPHA &&
                  vkv::kConstantColor == VK_BLEND_FACTOR_CONSTANT_COLOR &&
                  vkv::kSrcAlphaSaturate == VK_BLEND_FACTOR_SRC_ALPHA_SATURATE &&
                  vkv::kOneMinusSrcColor == VK_BLEND_FACTOR_ONE_MINUS_SRC_COLOR,
              "VkBlendFactor");
static_assert(vkv::kOpReverseSubtract == VK_BLEND_OP_REVERSE_SUBTRACT &&
                  vkv::kOpMax == VK_BLEND_OP_MAX && vkv::kOpMin == VK_BLEND_OP_MIN,
              "VkBlendOp");
static_assert(vkv::kClampToEdge == VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE &&
                  vkv::kMirroredRepeat == VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT &&
                  vkv::kRepeat == VK_SAMPLER_ADDRESS_MODE_REPEAT,
              "VkSamplerAddressMode");
static_assert(vkv::kLinear == VK_FILTER_LINEAR && vkv::kNearest == VK_FILTER_NEAREST &&
                  vkv::kLinear == VK_SAMPLER_MIPMAP_MODE_LINEAR,
              "VkFilter, VkSamplerMipmapMode");
static_assert(vkv::kTriangleStrip == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP &&
                  vkv::kLineStrip == VK_PRIMITIVE_TOPOLOGY_LINE_STRIP &&
                  vkv::kPointList == VK_PRIMITIVE_TOPOLOGY_POINT_LIST &&
                  vkv::kTriangleList == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
              "VkPrimitiveTopology");

namespace {

double seconds() { return std::chrono::duration<double>(Clock::now().time_since_epoch()).count(); }

template <class T> T vkStruct(VkStructureType type) {
    T value{};
    value.sType = type;
    return value;
}

void vk(VkResult result, const char *operation) {
    if (result != VK_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": VkResult " + std::to_string(result));
}

float srgbEncode(float c) {
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}

/** A buffer for one GpuVertices/GpuIndices/GpuInstances, alive while the model holds it. */
struct Buffer {
    VkBuffer buffer = VK_NULL_HANDLE;
    VmaAllocation allocation = nullptr;
    size_t size = 0, uploaded = 0;
    std::weak_ptr<const void> owner;
    // Vertex buffers: the positions' box, gathered while uploading (the CPU copy is then
    // released), as the GLES renderer's Buffer.
    float lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
    bool boxValid = true, boxAny = false;
    bool ready() const { return uploaded >= size; }
};

/** A complete, sampled texture (or one being uploaded in an UploadJob). */
struct Texture {
    VkImage image = VK_NULL_HANDLE;
    VmaAllocation allocation = nullptr;
    VkImageView view = VK_NULL_HANDLE;
    int w = 0, h = 0;
    uint32_t levels = 1;
    bool mips = false, srgb = false;
    SamplerSetup sampler;
    uint64_t uid = 0; // a new value for every image, for the shadow hash
};

struct UploadJob {
    TextureOp op;
    Texture tex; // image null until the upload starts
    int row = 0;
};

/** A program's two shader modules, shared by the pipelines made from it (worker side). */
struct Modules {
    VkShaderModule vertex = VK_NULL_HANDLE, fragment = VK_NULL_HANDLE;
    bool done = false, failed = false;
    std::string error;
};

struct PipelineJob {
    PipelineKey key;
    ProgramKey program;
    PipelineState state;
    VkRenderPass renderPass = VK_NULL_HANDLE;
    VkSampleCountFlagBits samples = VK_SAMPLE_COUNT_1_BIT;
    uint64_t generation = 0;
    bool compileOnly = false; // warm the program's SPIR-V and modules only
};

struct PipelineResult {
    PipelineKey key;
    uint32_t program = 0;
    ProgramKey programKey;
    VkPipeline pipeline = VK_NULL_HANDLE;
    std::string error;
    uint64_t generation = 0;
    bool compileOnly = false;
    bool programFailed = false; // the program did not compile: no state of it can draw
};

struct Pipeline {
    VkPipeline pipeline = VK_NULL_HANDLE;
    bool ready = false, failed = false;
};

/**
 * The vertex input of a draw (the GLES renderer's vao): binding 0 the interleaved vertices
 * (per instance for points drawn as quads), binding 1 the instances, binding 2 a stride-0 buffer
 * of GL's current attribute values (setDefaultAttributes) for every array a draw leaves off.
 */
struct VertexInput {
    VkVertexInputBindingDescription bindings[3];
    VkVertexInputAttributeDescription attributes[kAttrCount];
    uint32_t bindingCount = 0;
};

// Offsets of the defaults buffer (binding 2): GL's current attribute values, as vec4 floats.
constexpr uint32_t kDefaultNormal = 0, kDefaultUv = 16, kDefaultColor = 32, kDefaultInstance0 = 48,
                   kDefaultInstanceColor = 96, kDefaultsBytes = 112;

VertexInput vertexInput(const VertexLayout &layout) {
    VertexInput v{};
    const VkVertexInputRate rate =
        layout.pointQuads ? VK_VERTEX_INPUT_RATE_INSTANCE : VK_VERTEX_INPUT_RATE_VERTEX;
    v.bindings[v.bindingCount++] = {0, kVertexStride, rate};
    if (layout.instances)
        v.bindings[v.bindingCount++] = {1, kInstanceStride, VK_VERTEX_INPUT_RATE_INSTANCE};
    // Stride 0: every vertex reads the same constant ([VK] "Vertex Input Address Calculation").
    v.bindings[v.bindingCount++] = {2, 0, VK_VERTEX_INPUT_RATE_VERTEX};
    auto at = [&](uint32_t location, uint32_t binding, VkFormat format, uint32_t offset) {
        v.attributes[location] = {location, binding, format, offset};
    };
    at(kAttrPosition, 0, VK_FORMAT_R32G32B32_SFLOAT, kOffsetPosition);
    // GL_INT_2_10_10_10_REV normalized: x in bits 0-9 ... w in 30-31, as A2B10G10R10's R..A.
    if (layout.normal)
        at(kAttrNormal, 0, VK_FORMAT_A2B10G10R10_SNORM_PACK32, kOffsetNormal);
    else
        at(kAttrNormal, 2, VK_FORMAT_R32G32B32A32_SFLOAT, kDefaultNormal);
    if (layout.uv)
        at(kAttrUv, 0, VK_FORMAT_R32G32_SFLOAT, kOffsetUv);
    else
        at(kAttrUv, 2, VK_FORMAT_R32G32B32A32_SFLOAT, kDefaultUv);
    if (layout.color)
        at(kAttrColor, 0, VK_FORMAT_R16G16B16A16_SFLOAT, kOffsetColor); // GL_HALF_FLOAT x 4
    else
        at(kAttrColor, 2, VK_FORMAT_R32G32B32A32_SFLOAT, kDefaultColor);
    for (uint32_t r = 0; r < 3; r++) {
        if (layout.instances)
            at(kAttrInstance0 + r, 1, VK_FORMAT_R32G32B32A32_SFLOAT, r * 16);
        else
            at(kAttrInstance0 + r, 2, VK_FORMAT_R32G32B32A32_SFLOAT, kDefaultInstance0 + r * 16);
    }
    if (layout.instances)
        at(kAttrInstanceColor, 1, VK_FORMAT_R32G32B32_SFLOAT, 48);
    else
        at(kAttrInstanceColor, 2, VK_FORMAT_R32G32B32A32_SFLOAT, kDefaultInstanceColor);
    return v;
}

void copyMat3(const float *m, Mat3Std &out) {
    for (int c = 0; c < 3; c++)
        for (int r = 0; r < 3; r++)
            out.c[c * 4 + r] = m[c * 3 + r];
}

/** The 4 x (view, sampler) of a material's descriptor set (set 1). */
struct MaterialSetKey {
    VkImageView view[4] = {};
    VkSampler sampler[4] = {};
    bool operator==(const MaterialSetKey &o) const {
        return std::memcmp(this, &o, sizeof *this) == 0;
    }
};
struct MaterialSetHash {
    size_t operator()(const MaterialSetKey &k) const {
        uint64_t h = 0;
        for (int i = 0; i < 4; i++) {
            h = mix64(h, uint64_t(reinterpret_cast<uintptr_t>(k.view[i])));
            h = mix64(h, uint64_t(reinterpret_cast<uintptr_t>(k.sampler[i])));
        }
        return size_t(h);
    }
};

struct SamplerHash {
    size_t operator()(const SamplerSetup &s) const {
        uint64_t h = s.mag | s.min << 4 | s.mipmap << 8 | s.wrapS << 12 | s.wrapT << 16;
        uint32_t a = 0;
        std::memcpy(&a, &s.anisotropy, sizeof a);
        return size_t(mix64(h, a));
    }
};

/** One frame slot's rings: uniforms (Frame, Sky, then View and Draw blocks), staging, indices. */
struct Slot {
    VkBuffer uniforms = VK_NULL_HANDLE;
    VmaAllocation uniformAllocation = nullptr;
    uint8_t *uniformBytes = nullptr;
    size_t ringUsed = 0; // bytes of the dynamic ring used this frame
    VkBuffer staging = VK_NULL_HANDLE;
    VmaAllocation stagingAllocation = nullptr;
    uint8_t *stagingBytes = nullptr;
    size_t stagingUsed = 0;
    VkBuffer closures = VK_NULL_HANDLE; // line loop closing indices
    VmaAllocation closureAllocation = nullptr;
    uint32_t *closureIndices = nullptr;
    uint32_t closuresUsed = 0;
    VkDescriptorSet frameSet = VK_NULL_HANDLE, drawSet = VK_NULL_HANDLE;
    VkImageView shadowBound = VK_NULL_HANDLE; // the shadow map view frameSet holds
    VkQueryPool queries = VK_NULL_HANDLE;
    bool queryPending = false, queryStarted = false;
};

} // namespace

struct VkSceneRenderer::Impl final : SceneResidency {
    SceneRendererOptions options;
    SceneStream stream;
    SceneFramePlanner frame;

    mutable std::mutex statsMutex; // guards frameStats, read by stats() on any thread
    SceneStats frameStats;
    SceneStats stats;

    // ---- Device ---------------------------------------------------------------------------------
    bool initialized = false;
    VkSceneDevice dev;
    VmaAllocator allocator = nullptr;
    VkPhysicalDeviceProperties properties{};
    float maxAnisotropy = 1;
    VkFormat shadowFormat = VK_FORMAT_UNDEFINED;
    VkImageAspectFlags shadowAspects = VK_IMAGE_ASPECT_DEPTH_BIT;
    bool shadowLinear = false, mipsSrgb = false, mipsUnorm = false;
    VkDeviceSize uboAlign = 256;
    std::string cachePath;
    VkPipelineCache pipelineCache = VK_NULL_HANDLE;
    VkDescriptorSetLayout setLayouts[3] = {};
    VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
    VkDescriptorPool slotPool = VK_NULL_HANDLE;
    std::vector<VkDescriptorPool> materialPools;
    std::unordered_map<MaterialSetKey, VkDescriptorSet, MaterialSetHash> materialSets;
    std::unordered_map<SamplerSetup, VkSampler, SamplerHash> samplers;
    VkSampler shadowSampler = VK_NULL_HANDLE;
    std::vector<Slot> slots;
    uint32_t slotCount = 0;
    size_t frameBlockOffset = 0, skyBlockOffset = 0, ringOffset = 0, ringBytes = 0;
    size_t stagingBytes = 0;
    static constexpr uint32_t kClosureCapacity = 16384;
    VkBuffer defaults = VK_NULL_HANDLE;
    VmaAllocation defaultsAllocation = nullptr;

    // ---- Target and pipelines -------------------------------------------------------------------
    VkSceneTarget target;
    uint64_t targetGeneration = 0; // bumps when the world pipelines must be rebuilt
    VkRenderPass shadowPass = VK_NULL_HANDLE;
    std::unordered_map<PipelineKey, Pipeline, PipelineKeyHash> pipelines;
    std::unordered_set<uint32_t> failedPrograms; // bits() whose program did not compile
    uint32_t programsFailed = 0;
    std::vector<PipelineKey> wanted; // requested while drawing, started by the next prepareFrame
    bool drawing = false;
    ScenePipeline programSentinel; // the planner's "has a program": draws pick their pipelines
    uint64_t warmedSerial = 0;

    // ---- Workers (pipelines are created off the render thread) ----------------------------------
    std::vector<std::thread> workers;
    std::mutex workMutex;
    std::condition_variable workReady, modulesReady, workIdle;
    std::deque<PipelineJob> jobs, warmJobs;
    std::vector<PipelineResult> results;
    std::unordered_map<uint32_t, Modules> modules; // by ProgramKey::bits(), guarded by workMutex
    size_t jobsRunning = 0;
    bool stopping = false;
    std::unordered_set<uint32_t> warmRequested; // render thread: programs sent to warm

    // ---- Resources ------------------------------------------------------------------------------
    std::shared_ptr<const RenderState> current, pending;
    double pendingSince = 0;
    std::unordered_map<uint64_t, Buffer> buffers; // by serial
    std::unordered_map<uint32_t, Texture> textures;
    std::deque<UploadJob> uploads;
    uint64_t nextUid = 1;
    Texture white, clearTex, fallbackShadow;
    bool gpuInitRecorded = false;
    // Line loops: the closing pair of an indexed loop, read from the indices before their CPU
    // copy is released (by indices serial, first, count).
    struct LoopKey {
        uint64_t serial;
        uint32_t first, count;
        bool operator==(const LoopKey &o) const {
            return serial == o.serial && first == o.first && count == o.count;
        }
    };
    struct LoopHash {
        size_t operator()(const LoopKey &k) const {
            return size_t(mix64(mix64(k.serial, k.first), k.count));
        }
    };
    std::unordered_map<LoopKey, std::pair<uint32_t, uint32_t>, LoopHash> loopClosures;
    bool loopReported = false;

    // Shadow map.
    Texture shadowMap;
    VkFramebuffer shadowFramebuffer = VK_NULL_HANDLE;
    int shadowSize = 0;
    uint64_t shadowHash = ~0ull;
    bool shadowDrawn = false;

    // Deferred destruction: what a frame's commands may still use, freed once it completed.
    std::deque<std::pair<uint64_t, std::function<void()>>> retired;

    // ---- Per frame ------------------------------------------------------------------------------
    uint64_t frameIndex = 0;
    Slot *slot = nullptr;
    FrameBudget work;
    bool prepared = false;
    bool copies = false; // buffer copies recorded this frame (one barrier at the end)
    float prepareMs = 0, drawMs = 0, windowMax = 0, cpuMaxMs = 0;
    int windowFrames = 0;
    bool cpuWindowDone = false;
    float gpuMs = -1;
    bool ringReported = false, stagingReported = false;

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
        VK_SCENE_LOG("%s", message.c_str());
        stream.setError(message);
    }

    // ---- SceneResidency -------------------------------------------------------------------------
    // The planner asks for a program; a draw then picks the pipeline for its own state
    // (pipelineFor) and is skipped, and requested, while that one is not ready.
    const ScenePipeline *drawPipeline(const ProgramKey &key) override {
        return failedPrograms.count(key.bits()) ? nullptr : &programSentinel;
    }
    // The screen layer is not drawn through Vulkan yet (research/vulkan-port.md M3).
    const ScenePipeline *readyPipeline(const ProgramKey &) const override { return nullptr; }
    bool textureResident(uint32_t id) const override { return textures.count(id) != 0; }
    bool vertexBox(uint64_t serial, float lo[3], float hi[3]) const override {
        auto b = buffers.find(serial);
        if (b == buffers.end() || !b->second.ready() || !b->second.boxValid || !b->second.boxAny)
            return false;
        std::copy(b->second.lo, b->second.lo + 3, lo);
        std::copy(b->second.hi, b->second.hi + 3, hi);
        return true;
    }

    // ---- Deferred destruction -------------------------------------------------------------------

    /** Runs `destroy` once every frame up to the one being recorded has completed. */
    void retire(std::function<void()> destroy) {
        retired.emplace_back(frameIndex, std::move(destroy));
    }

    void destroyTexture(Texture &t) {
        if (t.view) {
            forgetMaterialSets(t.view);
            vkDestroyImageView(dev.device, t.view, nullptr);
        }
        if (t.image)
            vmaDestroyImage(allocator, t.image, t.allocation);
        t = Texture{};
    }

    void retireTexture(Texture &t) {
        if (!t.image)
            return;
        Texture old = t;
        t = Texture{};
        retire([this, old]() mutable { destroyTexture(old); });
    }

    void retireBuffer(Buffer &b) {
        if (!b.buffer)
            return;
        VkBuffer buffer = b.buffer;
        VmaAllocation allocation = b.allocation;
        b.buffer = VK_NULL_HANDLE;
        b.allocation = nullptr;
        retire([this, buffer, allocation] { vmaDestroyBuffer(allocator, buffer, allocation); });
    }

    /** Material descriptor sets that hold `view` are freed with it (its frames completed). */
    void forgetMaterialSets(VkImageView view) {
        for (auto it = materialSets.begin(); it != materialSets.end();) {
            const MaterialSetKey &k = it->first;
            if (std::find(std::begin(k.view), std::end(k.view), view) == std::end(k.view)) {
                ++it;
                continue;
            }
            // The set came from one of the pools; freeing returns it ([VK] vkFreeDescriptorSets,
            // FREE_DESCRIPTOR_SET_BIT pools).
            for (VkDescriptorPool pool : materialPools)
                if (vkFreeDescriptorSets(dev.device, pool, 1, &it->second) == VK_SUCCESS)
                    break;
            it = materialSets.erase(it);
        }
    }

    // ---- Bring-up -------------------------------------------------------------------------------

    VkFormatFeatureFlags optimalFeatures(VkFormat format) const {
        VkFormatProperties p{};
        vkGetPhysicalDeviceFormatProperties(dev.physical, format, &p);
        return p.optimalTilingFeatures;
    }

    bool init(const VkSceneDevice &device, uint32_t frameSlots, const std::string &path) {
        if (initialized)
            return true;
        dev = device;
        slotCount = std::max(1u, frameSlots);
        cachePath = path;
        if (!options.multiview) {
            fail("the Vulkan scene renderer draws multiview passes only");
            return false;
        }
        vkGetPhysicalDeviceProperties(dev.physical, &properties);
        maxAnisotropy = dev.samplerAnisotropy ? properties.limits.maxSamplerAnisotropy : 1.0f;
        uboAlign = std::max<VkDeviceSize>(16, properties.limits.minUniformBufferOffsetAlignment);
        // The interleaved normal is GL_INT_2_10_10_10_REV; its Vulkan twin is optional for vertex
        // buffers ([VK] "Required Format Support" lists it without VERTEX_BUFFER_BIT).
        VkFormatProperties normal{};
        vkGetPhysicalDeviceFormatProperties(dev.physical, VK_FORMAT_A2B10G10R10_SNORM_PACK32,
                                            &normal);
        if (!(normal.bufferFeatures & VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT)) {
            fail("VK_FORMAT_A2B10G10R10_SNORM_PACK32 is not a vertex format on this device");
            return false;
        }
        // The shadow map: a sampled depth attachment, filtered linearly when the format allows
        // (GL's GL_LINEAR depth comparison, depthParams).
        for (VkFormat f :
             {VK_FORMAT_D32_SFLOAT, VK_FORMAT_D24_UNORM_S8_UINT, VK_FORMAT_D16_UNORM}) {
            const auto features = optimalFeatures(f);
            const auto need = VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT |
                              VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT |
                              VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
            if ((features & need) != need)
                continue;
            if (shadowFormat == VK_FORMAT_UNDEFINED)
                shadowFormat = f;
            if (features & VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT) {
                shadowFormat = f;
                shadowLinear = true;
                break;
            }
        }
        if (shadowFormat == VK_FORMAT_UNDEFINED) {
            fail("no sampled depth format for the shadow map");
            return false;
        }
        // A combined depth/stencil image's barriers name both aspects (Vulkan 1.1 without
        // separateDepthStencilLayouts); its views sample depth only.
        shadowAspects = shadowFormat == VK_FORMAT_D24_UNORM_S8_UINT
                            ? VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT
                            : VK_IMAGE_ASPECT_DEPTH_BIT;
        // Mipmaps by vkCmdBlitImage need blit source, destination and linear filtering ([VK-MIP]).
        const auto blit = VK_FORMAT_FEATURE_BLIT_SRC_BIT | VK_FORMAT_FEATURE_BLIT_DST_BIT |
                          VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
        mipsSrgb = (optimalFeatures(VK_FORMAT_R8G8B8A8_SRGB) & blit) == blit;
        mipsUnorm = (optimalFeatures(VK_FORMAT_R8G8B8A8_UNORM) & blit) == blit;

        VmaAllocatorCreateInfo allocatorInfo{};
        allocatorInfo.vulkanApiVersion = VK_API_VERSION_1_1;
        allocatorInfo.physicalDevice = dev.physical;
        allocatorInfo.device = dev.device;
        allocatorInfo.instance = dev.instance;
        vk(vmaCreateAllocator(&allocatorInfo, &allocator), "vmaCreateAllocator");

        createPipelineCache();
        createLayouts();
        createSlots();
        createStaticResources();
        createShadowPass();

        const unsigned threads = 2;
        for (unsigned i = 0; i < threads; i++)
            workers.emplace_back([this] { workerLoop(); });
        initialized = true;
        VK_SCENE_LOG("vulkan scene renderer ready: %s slots=%u shadow=%d linear=%d mips=%d/%d "
                     "anisotropy=%.0f workers=%u",
                     properties.deviceName, slotCount, int(shadowFormat), int(shadowLinear),
                     int(mipsSrgb), int(mipsUnorm), double(maxAnisotropy), threads);
        return true;
    }

    /**
     * [VK] vkCreatePipelineCache: initial data the implementation does not accept is ignored.
     * Godot checks the header first ([GD-RDV] pipeline_cache_create): length, version, vendor,
     * device and pipelineCacheUUID; the same check here keeps a stale file out.
     */
    void createPipelineCache() {
        std::vector<char> data;
        if (!cachePath.empty()) {
            std::ifstream in(cachePath, std::ios::binary);
            data.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
        }
        bool usable = data.size() >= 16 + VK_UUID_SIZE;
        if (usable) {
            uint32_t header[4];
            std::memcpy(header, data.data(), sizeof header);
            usable = header[0] >= 16 + VK_UUID_SIZE &&
                     header[1] == VK_PIPELINE_CACHE_HEADER_VERSION_ONE &&
                     header[2] == properties.vendorID && header[3] == properties.deviceID &&
                     std::memcmp(data.data() + 16, properties.pipelineCacheUUID, VK_UUID_SIZE) == 0;
        }
        auto info =
            vkStruct<VkPipelineCacheCreateInfo>(VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO);
        if (usable) {
            info.initialDataSize = data.size();
            info.pInitialData = data.data();
        }
        vk(vkCreatePipelineCache(dev.device, &info, nullptr, &pipelineCache),
           "vkCreatePipelineCache");
        VK_SCENE_LOG("vulkan pipeline cache %s (%zu bytes)", usable ? "loaded" : "empty",
                     usable ? data.size() : size_t(0));
    }

    void createLayouts() {
        // Set 0, per frame: Frame, Sky, View (dynamic: one per render call), shadow map and the
        // screen layer's world depth (scene_uniforms.h; [NDK-DN] "group by frequency").
        const VkShaderStageFlags both = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;
        const VkDescriptorSetLayoutBinding frameBindings[] = {
            {kBlockFrame, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, both, nullptr},
            {kBlockSky, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, both, nullptr},
            {kBlockView, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1, both, nullptr},
            {uint32_t(kUnitShadowMap), VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
             VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
            {uint32_t(kUnitSharpDepth), VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
             VK_SHADER_STAGE_FRAGMENT_BIT, nullptr},
        };
        VkDescriptorSetLayoutBinding materialBindings[4];
        for (uint32_t i = 0; i < 4; i++)
            materialBindings[i] = {i, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
                                   VK_SHADER_STAGE_FRAGMENT_BIT, nullptr};
        const VkDescriptorSetLayoutBinding drawBinding = {
            kBindingDraw, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1, both, nullptr};
        const struct {
            const VkDescriptorSetLayoutBinding *bindings;
            uint32_t count;
        } sets[3] = {{frameBindings, 5}, {materialBindings, 4}, {&drawBinding, 1}};
        static_assert(kSetFrame == 0 && kSetMaterial == 1 && kSetDraw == 2, "set order");
        for (int i = 0; i < 3; i++) {
            auto info = vkStruct<VkDescriptorSetLayoutCreateInfo>(
                VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO);
            info.bindingCount = sets[i].count;
            info.pBindings = sets[i].bindings;
            vk(vkCreateDescriptorSetLayout(dev.device, &info, nullptr, &setLayouts[i]),
               "vkCreateDescriptorSetLayout");
        }
        auto layout =
            vkStruct<VkPipelineLayoutCreateInfo>(VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO);
        layout.setLayoutCount = 3;
        layout.pSetLayouts = setLayouts;
        vk(vkCreatePipelineLayout(dev.device, &layout, nullptr, &pipelineLayout),
           "vkCreatePipelineLayout");
    }

    struct HostBuffer {
        VkBuffer buffer = VK_NULL_HANDLE;
        VmaAllocation allocation = nullptr;
        void *mapped = nullptr;
    };

    /** A persistently mapped, host-written buffer ([VMA] "Staging copy for upload", MAPPED). */
    HostBuffer hostBuffer(VkDeviceSize size, VkBufferUsageFlags usage) {
        auto info = vkStruct<VkBufferCreateInfo>(VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO);
        info.size = size;
        info.usage = usage;
        info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        VmaAllocationCreateInfo create{};
        create.usage = VMA_MEMORY_USAGE_AUTO;
        create.flags = VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT |
                       VMA_ALLOCATION_CREATE_MAPPED_BIT;
        // Coherent memory: host writes before vkQueueSubmit are visible to the device ([VK]
        // "Host Write Ordering Guarantees") without a flush.
        create.requiredFlags =
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        HostBuffer out;
        VmaAllocationInfo allocation{};
        vk(vmaCreateBuffer(allocator, &info, &create, &out.buffer, &out.allocation, &allocation),
           "vmaCreateBuffer host");
        out.mapped = allocation.pMappedData;
        return out;
    }

    void createSlots() {
        frameBlockOffset = 0;
        skyBlockOffset = size_t(alignUp(sizeof(FrameBlock), uboAlign));
        ringOffset = size_t(alignUp(skyBlockOffset + sizeof(SkyBlock), uboAlign));
        // About 6000 draw blocks a frame at a 256-byte alignment (the office draws a few hundred).
        ringBytes = 4u << 20;
        stagingBytes = options.uploadBytesPerFrame + (1u << 20);
        // Pools: per slot one set 0 (2 uniform buffers, 1 dynamic, 2 samplers) and one set 2.
        const VkDescriptorPoolSize sizes[] = {
            {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 2 * slotCount},
            {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 2 * slotCount},
            {VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 2 * slotCount},
        };
        auto poolInfo =
            vkStruct<VkDescriptorPoolCreateInfo>(VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO);
        poolInfo.maxSets = 2 * slotCount;
        poolInfo.poolSizeCount = 3;
        poolInfo.pPoolSizes = sizes;
        vk(vkCreateDescriptorPool(dev.device, &poolInfo, nullptr, &slotPool),
           "vkCreateDescriptorPool slots");
        slots.resize(slotCount);
        for (Slot &s : slots) {
            HostBuffer u = hostBuffer(ringOffset + ringBytes, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT);
            s.uniforms = u.buffer;
            s.uniformAllocation = u.allocation;
            s.uniformBytes = static_cast<uint8_t *>(u.mapped);
            HostBuffer st = hostBuffer(stagingBytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
            s.staging = st.buffer;
            s.stagingAllocation = st.allocation;
            s.stagingBytes = static_cast<uint8_t *>(st.mapped);
            HostBuffer c =
                hostBuffer(kClosureCapacity * sizeof(uint32_t), VK_BUFFER_USAGE_INDEX_BUFFER_BIT);
            s.closures = c.buffer;
            s.closureAllocation = c.allocation;
            s.closureIndices = static_cast<uint32_t *>(c.mapped);
            VkDescriptorSetLayout layouts[2] = {setLayouts[kSetFrame], setLayouts[kSetDraw]};
            VkDescriptorSet sets[2];
            auto allocate = vkStruct<VkDescriptorSetAllocateInfo>(
                VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO);
            allocate.descriptorPool = slotPool;
            allocate.descriptorSetCount = 2;
            allocate.pSetLayouts = layouts;
            vk(vkAllocateDescriptorSets(dev.device, &allocate, sets), "vkAllocateDescriptorSets");
            s.frameSet = sets[0];
            s.drawSet = sets[1];
            const VkDescriptorBufferInfo infos[] = {
                {s.uniforms, frameBlockOffset, sizeof(FrameBlock)},
                {s.uniforms, skyBlockOffset, sizeof(SkyBlock)},
                {s.uniforms, ringOffset, sizeof(ViewBlock)},  // dynamic offset added per bind
                {s.uniforms, ringOffset, sizeof(DrawBlock)}}; // dynamic offset added per draw
            VkWriteDescriptorSet writes[4];
            const struct {
                VkDescriptorSet set;
                uint32_t binding;
                VkDescriptorType type;
            } targets[4] = {{s.frameSet, kBlockFrame, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER},
                            {s.frameSet, kBlockSky, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER},
                            {s.frameSet, kBlockView, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC},
                            {s.drawSet, kBindingDraw, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC}};
            for (int i = 0; i < 4; i++) {
                writes[i] = vkStruct<VkWriteDescriptorSet>(VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET);
                writes[i].dstSet = targets[i].set;
                writes[i].dstBinding = targets[i].binding;
                writes[i].descriptorCount = 1;
                writes[i].descriptorType = targets[i].type;
                writes[i].pBufferInfo = &infos[i];
            }
            vkUpdateDescriptorSets(dev.device, 4, writes, 0, nullptr);
            if (dev.timestampValidBits) {
                auto query =
                    vkStruct<VkQueryPoolCreateInfo>(VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO);
                query.queryType = VK_QUERY_TYPE_TIMESTAMP;
                // Reserve both views at each boundary. Mesa lavapipe can retain multiview
                // query expansion after vkCmdEndRenderPass, even for an outside timestamp.
                query.queryCount = 4;
                vk(vkCreateQueryPool(dev.device, &query, nullptr, &s.queries), "vkCreateQueryPool");
            }
        }
    }

    Texture makeImage(int w, int h, VkFormat format, uint32_t levels, VkImageUsageFlags usage,
                      VkImageAspectFlags aspect) {
        Texture t;
        auto info = vkStruct<VkImageCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO);
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = format;
        info.extent = {uint32_t(w), uint32_t(h), 1};
        info.mipLevels = levels;
        info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = usage;
        info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        info.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        VmaAllocationCreateInfo create{};
        create.usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE;
        vk(vmaCreateImage(allocator, &info, &create, &t.image, &t.allocation, nullptr),
           "vmaCreateImage");
        auto view = vkStruct<VkImageViewCreateInfo>(VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO);
        view.image = t.image;
        view.viewType = VK_IMAGE_VIEW_TYPE_2D;
        view.format = format;
        view.subresourceRange = {aspect, 0, levels, 0, 1};
        vk(vkCreateImageView(dev.device, &view, nullptr, &t.view), "vkCreateImageView");
        t.w = w;
        t.h = h;
        t.levels = levels;
        t.uid = nextUid++;
        return t;
    }

    void createStaticResources() {
        // GL's current attribute values for disabled arrays (setDefaultAttributes).
        HostBuffer d = hostBuffer(kDefaultsBytes, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT);
        defaults = d.buffer;
        defaultsAllocation = d.allocation;
        const float values[28] = {0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0,
                                  0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1};
        static_assert(sizeof values == kDefaultsBytes, "defaults layout");
        std::memcpy(d.mapped, values, sizeof values);
        // 1x1 white and transparent black (the GLES makeTexture pair, GL_NEAREST) and a lit 1x1
        // depth for programs that sample the shadow map while none is drawn; their pixels are
        // cleared in the first prepareFrame (recordInit).
        white = makeImage(1, 1, VK_FORMAT_R8G8B8A8_UNORM, 1,
                          VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
                          VK_IMAGE_ASPECT_COLOR_BIT);
        white.sampler = samplerSetup(0x2901, 0x2901, 0x2600, 0x2600, false, 1, 1);
        clearTex = makeImage(1, 1, VK_FORMAT_R8G8B8A8_UNORM, 1,
                             VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
                             VK_IMAGE_ASPECT_COLOR_BIT);
        clearTex.sampler = white.sampler;
        fallbackShadow = makeImage(1, 1, shadowFormat, 1,
                                   VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
                                   VK_IMAGE_ASPECT_DEPTH_BIT);
        // GL_TEXTURE_COMPARE_MODE REF_TO_TEXTURE with GL_LEQUAL (depthParams): the sampled value
        // is (reference <= stored), as VK_COMPARE_OP_LESS_OR_EQUAL ([VK] "Depth Compare
        // Operation").
        auto info = vkStruct<VkSamplerCreateInfo>(VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO);
        info.magFilter = info.minFilter = shadowLinear ? VK_FILTER_LINEAR : VK_FILTER_NEAREST;
        info.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;
        info.addressModeU = info.addressModeV = info.addressModeW =
            VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
        info.compareEnable = VK_TRUE;
        info.compareOp = VK_COMPARE_OP_LESS_OR_EQUAL;
        info.maxLod = 0;
        vk(vkCreateSampler(dev.device, &info, nullptr, &shadowSampler), "vkCreateSampler shadow");
        for (Slot &s : slots)
            bindShadow(s, fallbackShadow.view);
    }

    void bindShadow(Slot &s, VkImageView view) {
        if (s.shadowBound == view)
            return;
        VkDescriptorImageInfo image{shadowSampler, view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
        auto write = vkStruct<VkWriteDescriptorSet>(VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET);
        write.dstSet = s.frameSet;
        write.dstBinding = uint32_t(kUnitShadowMap);
        write.descriptorCount = 1;
        write.descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
        write.pImageInfo = &image;
        vkUpdateDescriptorSets(dev.device, 1, &write, 0, nullptr);
        s.shadowBound = view;
    }

    /**
     * The shadow pass: one depth attachment, cleared, stored and left for sampling. The external
     * dependencies order it after earlier frames' fragment shaders read the map (write after read)
     * and before this frame's ([VK-SYNC] "Render to a depth image, then sample it").
     */
    void createShadowPass() {
        VkAttachmentDescription depth{};
        depth.format = shadowFormat;
        depth.samples = VK_SAMPLE_COUNT_1_BIT;
        depth.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
        depth.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
        depth.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
        depth.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
        depth.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        depth.finalLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
        VkAttachmentReference ref{0, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
        VkSubpassDescription subpass{};
        subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
        subpass.pDepthStencilAttachment = &ref;
        VkSubpassDependency dependencies[2]{};
        dependencies[0].srcSubpass = VK_SUBPASS_EXTERNAL;
        dependencies[0].dstSubpass = 0;
        dependencies[0].srcStageMask = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
        dependencies[0].dstStageMask =
            VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT | VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
        dependencies[0].srcAccessMask = 0;
        dependencies[0].dstAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_READ_BIT |
                                        VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[1].srcSubpass = 0;
        dependencies[1].dstSubpass = VK_SUBPASS_EXTERNAL;
        dependencies[1].srcStageMask = VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
        dependencies[1].dstStageMask = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
        dependencies[1].srcAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[1].dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
        auto info = vkStruct<VkRenderPassCreateInfo>(VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO);
        info.attachmentCount = 1;
        info.pAttachments = &depth;
        info.subpassCount = 1;
        info.pSubpasses = &subpass;
        info.dependencyCount = 2;
        info.pDependencies = dependencies;
        vk(vkCreateRenderPass(dev.device, &info, nullptr, &shadowPass),
           "vkCreateRenderPass shadow");
    }

    /** One image layout transition of all levels ([VK] vkCmdPipelineBarrier). */
    static void transition(VkCommandBuffer cmd, VkImage image, VkImageAspectFlags aspect,
                           uint32_t baseLevel, uint32_t levels, VkImageLayout from,
                           VkImageLayout to, VkAccessFlags srcAccess, VkAccessFlags dstAccess,
                           VkPipelineStageFlags srcStage, VkPipelineStageFlags dstStage) {
        auto barrier = vkStruct<VkImageMemoryBarrier>(VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER);
        barrier.srcAccessMask = srcAccess;
        barrier.dstAccessMask = dstAccess;
        barrier.oldLayout = from;
        barrier.newLayout = to;
        barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = image;
        barrier.subresourceRange = {aspect, baseLevel, levels, 0, 1};
        vkCmdPipelineBarrier(cmd, srcStage, dstStage, 0, 0, nullptr, 0, nullptr, 1, &barrier);
    }

    /** The first frame clears the fallback images and leaves them for sampling. */
    void recordInit(VkCommandBuffer cmd) {
        if (gpuInitRecorded)
            return;
        gpuInitRecorded = true;
        const VkImageSubresourceRange color{VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        const VkImageSubresourceRange depth{VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1};
        for (Texture *t : {&white, &clearTex, &fallbackShadow}) {
            const bool isDepth = t == &fallbackShadow;
            const VkImageAspectFlags aspect =
                isDepth ? shadowAspects : VkImageAspectFlags(VK_IMAGE_ASPECT_COLOR_BIT);
            transition(cmd, t->image, aspect, 0, 1, VK_IMAGE_LAYOUT_UNDEFINED,
                       VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 0, VK_ACCESS_TRANSFER_WRITE_BIT,
                       VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);
            if (isDepth) {
                const VkClearDepthStencilValue far{1, 0};
                vkCmdClearDepthStencilImage(cmd, t->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                                            &far, 1, &depth);
            } else {
                const float v = t == &white ? 1.0f : 0.0f;
                const VkClearColorValue value{{v, v, v, v}};
                vkCmdClearColorImage(cmd, t->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &value, 1,
                                     &color);
            }
            transition(cmd, t->image, aspect, 0, 1, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                       VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_ACCESS_TRANSFER_WRITE_BIT,
                       VK_ACCESS_SHADER_READ_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                       VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);
        }
    }

    VkSampler sampler(const SamplerSetup &s) {
        auto found = samplers.find(s);
        if (found != samplers.end())
            return found->second;
        auto info = vkStruct<VkSamplerCreateInfo>(VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO);
        info.magFilter = VkFilter(s.mag);
        info.minFilter = VkFilter(s.min);
        info.mipmapMode =
            s.mipmap ? VkSamplerMipmapMode(s.mipmap - 1) : VK_SAMPLER_MIPMAP_MODE_NEAREST;
        info.addressModeU = VkSamplerAddressMode(s.wrapS);
        info.addressModeV = VkSamplerAddressMode(s.wrapT);
        info.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
        info.anisotropyEnable = s.anisotropy > 1 ? VK_TRUE : VK_FALSE;
        info.maxAnisotropy = s.anisotropy;
        info.minLod = 0;
        // Without a mipmapped filter only the base level is sampled, as GL ([VK] "Level-of-Detail
        // Operation": maxLod 0 clamps lambda to the base level).
        info.maxLod = s.mipmap ? VK_LOD_CLAMP_NONE : 0.0f;
        VkSampler out = VK_NULL_HANDLE;
        vk(vkCreateSampler(dev.device, &info, nullptr, &out), "vkCreateSampler");
        samplers.emplace(s, out);
        return out;
    }

    // ---- Workers --------------------------------------------------------------------------------

    void workerLoop() {
#ifdef __ANDROID__
        // Below the display thread (OfficeActivity runs it at -4): builds wait, frames do not.
        setpriority(PRIO_PROCESS, 0, 4);
#endif
        ShaderCompiler compiler;
        for (;;) {
            PipelineJob job;
            {
                std::unique_lock<std::mutex> lock(workMutex);
                workReady.wait(lock,
                               [&] { return stopping || !jobs.empty() || !warmJobs.empty(); });
                if (stopping)
                    return;
                auto &queue = jobs.empty() ? warmJobs : jobs;
                job = queue.front();
                queue.pop_front();
                jobsRunning++;
            }
            PipelineResult result;
            result.key = job.key;
            result.program = job.program.bits();
            result.programKey = job.program;
            result.generation = job.generation;
            result.compileOnly = job.compileOnly;
            const Modules m = programModules(compiler, job.program);
            if (!m.done) {
                result.error = "stopped"; // teardown while another worker compiled it
            } else if (m.failed) {
                result.error = m.error;
                result.programFailed = true;
            } else if (!job.compileOnly) {
                result.pipeline = createPipeline(job, m, result.error);
            }
            std::lock_guard<std::mutex> lock(workMutex);
            jobsRunning--;
            results.push_back(std::move(result));
            workIdle.notify_all();
        }
    }

    /** The program's modules, compiling them once ([NDK-SC]); another worker's build is awaited. */
    Modules programModules(ShaderCompiler &compiler, const ProgramKey &key) {
        const uint32_t bits = key.bits();
        {
            std::unique_lock<std::mutex> lock(workMutex);
            auto found = modules.find(bits);
            if (found != modules.end()) {
                // A reference: unlike iterators, it stays valid when another insert rehashes.
                const Modules &entry = found->second;
                modulesReady.wait(lock, [&] { return entry.done || stopping; });
                return entry;
            }
            modules[bits] = Modules{};
        }
        Modules m;
        const ShaderSource source = generateShader(key, Dialect::Vulkan);
        const std::string name = programName(key);
        std::vector<uint32_t> vertex, fragment;
        if (!compiler.compile(source.vertex, true, name + ".vert", vertex, m.error) ||
            !compiler.compile(source.fragment, false, name + ".frag", fragment, m.error)) {
            m.failed = true;
        } else {
            for (int stage = 0; stage < 2 && !m.failed; stage++) {
                const auto &code = stage ? fragment : vertex;
                auto info =
                    vkStruct<VkShaderModuleCreateInfo>(VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO);
                info.codeSize = code.size() * sizeof(uint32_t);
                info.pCode = code.data();
                const VkResult r = vkCreateShaderModule(dev.device, &info, nullptr,
                                                        stage ? &m.fragment : &m.vertex);
                if (r != VK_SUCCESS) {
                    m.failed = true;
                    m.error = "vkCreateShaderModule " + std::to_string(r);
                }
            }
        }
        m.done = true;
        {
            std::lock_guard<std::mutex> lock(workMutex);
            modules[bits] = m;
        }
        modulesReady.notify_all();
        return m;
    }

    /** [HXR] CreatePipeline, with the GLES renderer's per-draw state as fixed state. */
    VkPipeline createPipeline(const PipelineJob &job, const Modules &m, std::string &error) {
        const PipelineState &s = job.state;
        if (s.topology == vkv::kPointList && job.program.model != ShadeModel::Points) {
            // Only PointsMaterial programs write gl_PointSize, which a point topology needs.
            error = "points drawn with a program that sets no point size";
            return VK_NULL_HANDLE;
        }
        VkPipelineShaderStageCreateInfo stages[2]{};
        for (int i = 0; i < 2; i++) {
            stages[i].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
            stages[i].stage = i ? VK_SHADER_STAGE_FRAGMENT_BIT : VK_SHADER_STAGE_VERTEX_BIT;
            stages[i].module = i ? m.fragment : m.vertex;
            stages[i].pName = "main";
        }
        const VertexInput input = vertexInput(s.vertex);
        auto vertex = vkStruct<VkPipelineVertexInputStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO);
        vertex.vertexBindingDescriptionCount = input.bindingCount;
        vertex.pVertexBindingDescriptions = input.bindings;
        vertex.vertexAttributeDescriptionCount = kAttrCount;
        vertex.pVertexAttributeDescriptions = input.attributes;
        auto assembly = vkStruct<VkPipelineInputAssemblyStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO);
        assembly.topology = VkPrimitiveTopology(s.topology);
        auto viewport = vkStruct<VkPipelineViewportStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO);
        viewport.viewportCount = 1;
        viewport.scissorCount = 1;
        auto raster = vkStruct<VkPipelineRasterizationStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO);
        raster.polygonMode = VK_POLYGON_MODE_FILL;
        raster.cullMode = s.cull ? VK_CULL_MODE_BACK_BIT : VK_CULL_MODE_NONE;
        raster.frontFace =
            s.frontClockwise ? VK_FRONT_FACE_CLOCKWISE : VK_FRONT_FACE_COUNTER_CLOCKWISE;
        // GL_POLYGON_OFFSET_FILL: factor and units come per draw (dynamic depth bias).
        raster.depthBiasEnable = s.depthBias ? VK_TRUE : VK_FALSE;
        raster.lineWidth = 1;
        auto multisample = vkStruct<VkPipelineMultisampleStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO);
        multisample.rasterizationSamples = job.samples;
        auto depth = vkStruct<VkPipelineDepthStencilStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO);
        depth.depthTestEnable = s.depthTest ? VK_TRUE : VK_FALSE;
        depth.depthWriteEnable = s.depthWrite ? VK_TRUE : VK_FALSE;
        depth.depthCompareOp = VkCompareOp(s.compare);
        VkPipelineColorBlendAttachmentState attachment{};
        attachment.blendEnable = s.blend.enable ? VK_TRUE : VK_FALSE;
        attachment.srcColorBlendFactor = VkBlendFactor(s.blend.srcColor);
        attachment.dstColorBlendFactor = VkBlendFactor(s.blend.dstColor);
        attachment.colorBlendOp = VkBlendOp(s.blend.colorOp);
        attachment.srcAlphaBlendFactor = VkBlendFactor(s.blend.srcAlpha);
        attachment.dstAlphaBlendFactor = VkBlendFactor(s.blend.dstAlpha);
        attachment.alphaBlendOp = VkBlendOp(s.blend.alphaOp);
        attachment.colorWriteMask = s.colorWrite
                                        ? VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                                              VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT
                                        : 0;
        auto blend = vkStruct<VkPipelineColorBlendStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO);
        // The shadow pass has no colour attachment (GL draws it with glDrawBuffers(GL_NONE)).
        blend.attachmentCount = s.pass == PassClass::Shadow ? 0 : 1;
        blend.pAttachments = &attachment;
        // Depth bias is dynamic only where it is enabled, so every draw that needs it sets it.
        const VkDynamicState dynamics[] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR,
                                           VK_DYNAMIC_STATE_DEPTH_BIAS};
        auto dynamic = vkStruct<VkPipelineDynamicStateCreateInfo>(
            VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO);
        dynamic.dynamicStateCount = s.depthBias ? 3 : 2;
        dynamic.pDynamicStates = dynamics;
        auto info =
            vkStruct<VkGraphicsPipelineCreateInfo>(VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO);
        info.stageCount = 2;
        info.pStages = stages;
        info.pVertexInputState = &vertex;
        info.pInputAssemblyState = &assembly;
        info.pViewportState = &viewport;
        info.pRasterizationState = &raster;
        info.pMultisampleState = &multisample;
        info.pDepthStencilState = &depth;
        info.pColorBlendState = &blend;
        info.pDynamicState = &dynamic;
        info.layout = pipelineLayout;
        info.renderPass = job.renderPass;
        info.subpass = 0;
        VkPipeline out = VK_NULL_HANDLE;
        // The pipeline cache is internally synchronized ([VK] "Pipeline Cache": unless created
        // with EXTERNALLY_SYNCHRONIZED), so the workers share it.
        const VkResult r =
            vkCreateGraphicsPipelines(dev.device, pipelineCache, 1, &info, nullptr, &out);
        if (r != VK_SUCCESS) {
            error = "vkCreateGraphicsPipelines " + std::to_string(r);
            return VK_NULL_HANDLE;
        }
        return out;
    }

    /** Render thread: takes the workers' finished builds. */
    void pollPipelines() {
        std::vector<PipelineResult> done;
        {
            std::lock_guard<std::mutex> lock(workMutex);
            done.swap(results);
        }
        for (PipelineResult &r : done) {
            if (r.programFailed && failedPrograms.insert(r.program).second) {
                // As the GLES finishProgram: cached as failed, not retried, reported once.
                programsFailed++;
                fail("vulkan shader " + programName(r.programKey) + " failed: " + r.error);
            }
            if (r.compileOnly)
                continue;
            auto it = pipelines.find(r.key);
            const bool world = isWorld(r.key);
            if (it == pipelines.end() || (world && r.generation != targetGeneration)) {
                // Made for a world pass that was replaced; no frame used it.
                if (r.pipeline)
                    vkDestroyPipeline(dev.device, r.pipeline, nullptr);
                continue;
            }
            if (r.pipeline) {
                it->second.pipeline = r.pipeline;
                it->second.ready = true;
                continue;
            }
            it->second.failed = true;
            if (!r.programFailed)
                fail("vulkan pipeline of " + programName(r.programKey) + " failed: " + r.error);
        }
    }

    size_t pendingBuilds() {
        std::lock_guard<std::mutex> lock(workMutex);
        return jobs.size() + jobsRunning;
    }

    /** The pipeline of a key, requesting its build when there is none (never while drawing). */
    const Pipeline *pipeline(const PipelineKey &key, const ProgramKey &program,
                             const PipelineState &state) {
        auto found = pipelines.find(key);
        if (found != pipelines.end())
            return &found->second;
        if (drawing) {
            if (std::find(wanted.begin(), wanted.end(), key) == wanted.end())
                wanted.push_back(key);
            pendingPrograms.emplace(key, std::make_pair(program, state));
            return nullptr;
        }
        request(key, program, state);
        return nullptr;
    }
    std::unordered_map<PipelineKey, std::pair<ProgramKey, PipelineState>, PipelineKeyHash>
        pendingPrograms;

    /** World pipelines depend on the target's render pass; shadow ones on the renderer's own. */
    static bool isWorld(const PipelineKey &key) {
        return (key.state & 3u) == uint32_t(PassClass::World); // packKey's pass bits
    }

    void request(const PipelineKey &key, const ProgramKey &program, const PipelineState &state) {
        const bool world = state.pass == PassClass::World;
        if (pipelines.count(key) || (world && !target.renderPass))
            return;
        pipelines[key] = Pipeline{};
        PipelineJob job;
        job.key = key;
        job.program = program;
        job.state = state;
        job.renderPass = world ? target.renderPass : shadowPass;
        job.samples = world ? target.samples : VK_SAMPLE_COUNT_1_BIT;
        job.generation = world ? targetGeneration : 0;
        {
            std::lock_guard<std::mutex> lock(workMutex);
            jobs.push_back(job);
        }
        workReady.notify_one();
    }

    /** Programs a state may need later (hidden objects, other materials): their modules only. */
    void warm(const RenderState &s) {
        if (warmedSerial == s.serial)
            return;
        warmedSerial = s.serial;
        size_t added = 0;
        {
            std::lock_guard<std::mutex> lock(workMutex);
            for (ProgramKey k : s.warmKeys) {
                if (k.model != ShadeModel::Depth)
                    k.multiview = true;
                if (!warmRequested.insert(k.bits()).second)
                    continue;
                PipelineJob job;
                job.program = k;
                job.compileOnly = true;
                warmJobs.push_back(job);
                added++;
            }
        }
        if (added)
            workReady.notify_all();
    }

    /** The world (or shadow) pipeline key of a draw and its program key variant. */
    static ProgramKey worldProgram(const DrawItem &it) {
        ProgramKey k = it.key;
        k.multiview = true; // every world pass is multiview (research/vulkan-port.md 4.3)
        return k;
    }

    void releaseTarget() {
        std::unique_lock<std::mutex> lock(workMutex);
        // No display thread can enqueue another job while replacing its target.
        jobs.clear();
        warmJobs.clear();
        workIdle.wait(lock, [&] { return jobsRunning == 0; });
        lock.unlock();
        pollPipelines();
    }

    void setTarget(const VkSceneTarget &t) {
        const bool rebuild = t.compatibility != target.compatibility ||
                             t.samples != target.samples || t.srgb != target.srgb ||
                             !target.renderPass;
        target = t;
        if (!rebuild)
            return;
        // World pipelines of another render pass class are built again for this one ([VK]
        // "Render Pass Compatibility"); frames may still execute the old ones, so they go with
        // those frames. Pending builds come back with the old generation and are dropped. Shadow
        // pipelines use the renderer's own pass and stay.
        targetGeneration++;
        for (auto it = pipelines.begin(); it != pipelines.end();) {
            if (!isWorld(it->first)) {
                ++it;
                continue;
            }
            if (VkPipeline p = it->second.pipeline)
                retire([this, p] { vkDestroyPipeline(dev.device, p, nullptr); });
            it = pipelines.erase(it);
        }
    }

    // ---- Uploads --------------------------------------------------------------------------------

    /** Staging bytes in this frame's slot, or SIZE_MAX when the ring is full. */
    size_t stage(size_t bytes) {
        const size_t at = size_t(alignUp(slot->stagingUsed, 16));
        if (at + bytes > stagingBytes)
            return SIZE_MAX;
        slot->stagingUsed = at + bytes;
        return at;
    }

    /** As the GLES upload: a band of the buffer within the budget; true once all of it is up. */
    template <typename T>
    bool upload(VkCommandBuffer cmd, VkBufferUsageFlags usage,
                const std::shared_ptr<const T> &src) {
        auto it = buffers.find(src->serial);
        if (it != buffers.end() && it->second.ready())
            return true;
        if (work.bytes == 0 || !work.mayWork())
            return false;
        work.worked = true;
        if (it == buffers.end()) {
            Buffer b;
            b.size = src->bytes.size();
            b.owner = src;
            auto info = vkStruct<VkBufferCreateInfo>(VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO);
            info.size = std::max<size_t>(b.size, 4);
            info.usage = usage | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
            info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
            VmaAllocationCreateInfo create{};
            create.usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE; // [VMA] "GPU-only resource"
            vk(vmaCreateBuffer(allocator, &info, &create, &b.buffer, &b.allocation, nullptr),
               "vmaCreateBuffer");
            it = buffers.emplace(src->serial, b).first;
        }
        Buffer &b = it->second;
        if (b.size == 0) {
            b.uploaded = b.size;
            return true;
        }
        const size_t n = std::min(b.size - b.uploaded, work.bytes);
        const size_t at = stage(n);
        if (at == SIZE_MAX) {
            if (!stagingReported) {
                stagingReported = true;
                VK_SCENE_LOG("vulkan staging ring full this frame; the rest goes next frame");
            }
            return false;
        }
        if constexpr (std::is_same_v<T, GpuVertices>)
            extendBox(b, *src, b.uploaded, b.uploaded + n);
        std::memcpy(slot->stagingBytes + at, src->bytes.data() + b.uploaded, n);
        const VkBufferCopy region{at, b.uploaded, n};
        vkCmdCopyBuffer(cmd, slot->staging, b.buffer, 1, &region);
        copies = true;
        b.uploaded += n;
        work.bytes -= n;
        stats.uploadedBytesLastFrame += n;
        if (!b.ready())
            return false;
        src->bytes.clear();
        src->bytes.shrink_to_fit();
        return true;
    }

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

    /** An indexed line loop's closing pair, read before the index bytes are released. */
    void noteLoop(const DrawItem &it) {
        if (it.mode != DrawMode::LineLoop || !it.indices || it.count < 2)
            return;
        const LoopKey key{it.indices->serial, it.first, it.count};
        if (loopClosures.count(key))
            return;
        const auto &bytes = it.indices->bytes;
        const size_t size = it.indices->wide ? 4 : 2;
        const size_t a = size_t(it.first) * size, b = size_t(it.first + it.count - 1) * size;
        if (b + size > bytes.size()) {
            if (!loopReported) {
                loopReported = true;
                VK_SCENE_LOG("vulkan line loop drawn open: its indices were released already");
            }
            return;
        }
        auto read = [&](size_t at) {
            if (size == 4) {
                uint32_t v;
                std::memcpy(&v, bytes.data() + at, 4);
                return v;
            }
            uint16_t v;
            std::memcpy(&v, bytes.data() + at, 2);
            return uint32_t(v);
        };
        loopClosures[key] = {read(b), read(a)};
    }

    bool texturesResident(const RenderState &s) const {
        for (uint32_t id : s.textures)
            if (!textures.count(id))
                return false;
        return true;
    }

    bool settled(const PipelineKey &key, const ProgramKey &program, const PipelineState &state) {
        if (failedPrograms.count(program.bits()))
            return true;
        auto found = pipelines.find(key);
        if (found == pipelines.end()) {
            request(key, program, state);
            return false;
        }
        return found->second.ready || found->second.failed;
    }

    /** As the GLES prepare: uploads what `s` needs; true once every buffer and pipeline is ready.
     */
    bool prepare(VkCommandBuffer cmd, const RenderState &s) {
        bool ready = true;
        for (const DrawItem &it : s.items)
            noteLoop(it);
        for (const DrawItem &it : s.items) {
            ready &= upload(cmd, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, it.vertices);
            if (it.indices)
                ready &= upload(cmd, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, it.indices);
            if (it.instances)
                ready &= upload(cmd, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, it.instances);
            const ProgramKey world = worldProgram(it);
            const PipelineState ws = worldState(it);
            ready &= settled(packKey(world.bits(), ws), world, ws);
            if (s.shadow && options.shadows && castsShadow(it)) {
                const PipelineState ss = shadowState(it);
                ready &= settled(packKey(it.depthKey.bits(), ss), it.depthKey, ss);
            }
        }
        return ready;
    }

    /** Buffers whose model object is gone go with the frames that used them. */
    void sweep() {
        for (auto it = buffers.begin(); it != buffers.end();) {
            if (!it->second.owner.expired()) {
                ++it;
                continue;
            }
            retireBuffer(it->second);
            it = buffers.erase(it);
        }
        for (auto it = loopClosures.begin(); it != loopClosures.end();)
            it = buffers.count(it->first.serial) ? std::next(it) : loopClosures.erase(it);
    }

    void adopt(VkCommandBuffer cmd) {
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
        if (!prepare(cmd, *pending))
            return;
        if (!current && !texturesResident(*pending) && seconds() - pendingSince < 3.0)
            return;
        current = std::move(pending);
        pending.reset();
        // Before sweep: the previous state's attached copies must not keep its buffers alive.
        frame.syncAttachments(*current);
        sweep();
    }

    // ---- Textures -------------------------------------------------------------------------------

    void deleteTexture(uint32_t id) {
        auto it = textures.find(id);
        if (it != textures.end()) {
            retireTexture(it->second);
            textures.erase(it);
        }
        for (auto j = uploads.begin(); j != uploads.end();) {
            if (j->op.id != id) {
                ++j;
                continue;
            }
            retireTexture(j->tex);
            j = uploads.erase(j);
        }
    }

    void clearTextures() {
        for (auto &[id, t] : textures)
            retireTexture(t);
        textures.clear();
        for (auto &j : uploads)
            retireTexture(j.tex);
        uploads.clear();
    }

    SamplerSetup samplerOf(const TextureOp &op, bool mips) const {
        return samplerSetup(op.wrapS, op.wrapT, op.mag, op.min, mips, op.aniso, maxAnisotropy);
    }

    void takeTextureOps() {
        std::deque<TextureOp> ops = stream.takeTextureOps(
            uploads.size(), size_t(std::max(1, options.textureUploadsPerFrame)) * 2);
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
                if (it != textures.end())
                    it->second.sampler = samplerOf(op, it->second.mips); // mips only if made
                for (auto &j : uploads)
                    if (j.op.id == op.id) {
                        j.op.wrapS = op.wrapS;
                        j.op.wrapT = op.wrapT;
                        j.op.mag = op.mag;
                        j.op.min = op.min;
                        j.op.aniso = op.aniso;
                    }
                break;
            }
            case TextureOp::Upload: {
                auto same = std::find_if(uploads.begin(), uploads.end(),
                                         [&](const UploadJob &j) { return j.op.id == op.id; });
                if (same == uploads.end()) {
                    uploads.push_back({std::move(op), Texture{}, 0});
                    break;
                }
                // Restart with the newer pixels; a different size or format needs a new image.
                const Image &a = same->op.image;
                if (same->tex.image && (a.w != op.image.w || a.h != op.image.h ||
                                        same->op.srgb != op.srgb || same->op.mips != op.mips))
                    retireTexture(same->tex);
                same->op = std::move(op);
                same->row = 0;
                break;
            }
            }
        }
    }

    /**
     * As the GLES pumpTextures: row bands within the budget, at most textureUploadsPerFrame new
     * textures a frame; a texture replaces the old one once complete ([VK-SYNC] "Upload data from
     * the CPU to an image sampled in a fragment shader").
     */
    void pumpTextures(VkCommandBuffer cmd) {
        takeTextureOps();
        int started = 0;
        for (auto j = uploads.begin(); j != uploads.end() && work.bytes > 0 && work.mayWork();) {
            UploadJob &job = *j;
            work.worked = true;
            const Image &img = job.op.image;
            if (img.w <= 0 || img.h <= 0) {
                retireTexture(job.tex);
                j = uploads.erase(j);
                continue;
            }
            const VkFormat format =
                job.op.srgb ? VK_FORMAT_R8G8B8A8_SRGB : VK_FORMAT_R8G8B8A8_UNORM;
            const bool mips = job.op.mips && (job.op.srgb ? mipsSrgb : mipsUnorm);
            if (!job.tex.image) {
                if (started >= options.textureUploadsPerFrame)
                    break;
                started++;
                uint32_t levels = 1;
                if (mips)
                    for (int s = std::max(img.w, img.h); s > 1; s >>= 1)
                        levels++;
                job.tex = makeImage(img.w, img.h, format, levels,
                                    VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                                        (levels > 1 ? VK_IMAGE_USAGE_TRANSFER_SRC_BIT : 0),
                                    VK_IMAGE_ASPECT_COLOR_BIT);
                job.tex.mips = levels > 1;
                job.tex.srgb = job.op.srgb;
                job.row = 0;
                transition(cmd, job.tex.image, VK_IMAGE_ASPECT_COLOR_BIT, 0, levels,
                           VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 0,
                           VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
                           VK_PIPELINE_STAGE_TRANSFER_BIT);
            }
            const size_t rowBytes = size_t(img.w) * 4;
            int rows = int(std::min<size_t>(size_t(img.h - job.row),
                                            std::max<size_t>(1, work.bytes / rowBytes)));
            const size_t at = stage(size_t(rows) * rowBytes);
            if (at == SIZE_MAX)
                break; // the staging ring is full: the rest next frame
            std::memcpy(slot->stagingBytes + at, img.rgba.data() + size_t(job.row) * rowBytes,
                        size_t(rows) * rowBytes);
            VkBufferImageCopy region{};
            region.bufferOffset = at;
            region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
            region.imageOffset = {0, job.row, 0};
            region.imageExtent = {uint32_t(img.w), uint32_t(rows), 1};
            vkCmdCopyBufferToImage(cmd, slot->staging, job.tex.image,
                                   VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
            job.row += rows;
            const size_t sent = size_t(rows) * rowBytes;
            work.bytes -= std::min(work.bytes, sent);
            stats.uploadedBytesLastFrame += sent;
            if (job.row < img.h)
                break; // the rest next frame
            finishTexture(cmd, job.tex);
            job.tex.sampler = samplerOf(job.op, job.tex.mips);
            auto old = textures.find(job.op.id);
            if (old != textures.end())
                retireTexture(old->second);
            textures[job.op.id] = job.tex;
            job.tex = Texture{};
            j = uploads.erase(j);
        }
    }

    /** Mipmaps by blits from each level to the next ([VK-MIP]), then every level for sampling. */
    void finishTexture(VkCommandBuffer cmd, const Texture &t) {
        int w = t.w, h = t.h;
        for (uint32_t level = 1; level < t.levels; level++) {
            transition(cmd, t.image, VK_IMAGE_ASPECT_COLOR_BIT, level - 1, 1,
                       VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                       VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT,
                       VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);
            const int nw = std::max(1, w / 2), nh = std::max(1, h / 2);
            VkImageBlit blit{};
            blit.srcSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, level - 1, 0, 1};
            blit.srcOffsets[1] = {w, h, 1};
            blit.dstSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, level, 0, 1};
            blit.dstOffsets[1] = {nw, nh, 1};
            vkCmdBlitImage(cmd, t.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, t.image,
                           VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit, VK_FILTER_LINEAR);
            transition(cmd, t.image, VK_IMAGE_ASPECT_COLOR_BIT, level - 1, 1,
                       VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                       VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_ACCESS_TRANSFER_READ_BIT,
                       VK_ACCESS_SHADER_READ_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                       VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);
            w = nw;
            h = nh;
        }
        transition(cmd, t.image, VK_IMAGE_ASPECT_COLOR_BIT, t.levels - 1, 1,
                   VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                   VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
                   VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);
    }

    const Texture *texture(uint32_t id) const {
        auto it = textures.find(id);
        return it == textures.end() ? nullptr : &it->second;
    }

    /**
     * Set 1 for a material: its maps, or transparent black for a map not on the GPU yet (three's
     * empty texture) and white for a missing gradient map, as the GLES bindMaps.
     */
    VkDescriptorSet materialSet(const MaterialState &m) {
        MaterialSetKey key;
        const uint32_t ids[4] = {m.map, m.alphaMap, m.emissiveMap, m.gradientMap};
        for (int i = 0; i < 4; i++) {
            const Texture *t = ids[i] ? texture(ids[i]) : nullptr;
            const Texture &use = t ? *t : (i == 3 ? white : clearTex);
            key.view[i] = use.view;
            key.sampler[i] = sampler(use.sampler);
        }
        auto found = materialSets.find(key);
        if (found != materialSets.end())
            return found->second;
        VkDescriptorSet set = allocateMaterialSet();
        VkDescriptorImageInfo images[4];
        VkWriteDescriptorSet writes[4];
        for (uint32_t i = 0; i < 4; i++) {
            images[i] = {key.sampler[i], key.view[i], VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
            writes[i] = vkStruct<VkWriteDescriptorSet>(VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET);
            writes[i].dstSet = set;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
            writes[i].pImageInfo = &images[i];
        }
        vkUpdateDescriptorSets(dev.device, 4, writes, 0, nullptr);
        materialSets.emplace(key, set);
        return set;
    }

    VkDescriptorSet allocateMaterialSet() {
        auto allocate =
            vkStruct<VkDescriptorSetAllocateInfo>(VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO);
        allocate.descriptorSetCount = 1;
        allocate.pSetLayouts = &setLayouts[kSetMaterial];
        VkDescriptorSet set = VK_NULL_HANDLE;
        if (!materialPools.empty()) {
            allocate.descriptorPool = materialPools.back();
            if (vkAllocateDescriptorSets(dev.device, &allocate, &set) == VK_SUCCESS)
                return set;
        }
        // A full (or fragmented) pool: another one ([VK] vkAllocateDescriptorSets returns
        // OUT_OF_POOL_MEMORY or FRAGMENTED_POOL; the application then makes a new pool).
        const VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 4 * 256};
        auto info =
            vkStruct<VkDescriptorPoolCreateInfo>(VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO);
        info.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
        info.maxSets = 256;
        info.poolSizeCount = 1;
        info.pPoolSizes = &size;
        VkDescriptorPool pool = VK_NULL_HANDLE;
        vk(vkCreateDescriptorPool(dev.device, &info, nullptr, &pool),
           "vkCreateDescriptorPool material");
        materialPools.push_back(pool);
        allocate.descriptorPool = pool;
        vk(vkAllocateDescriptorSets(dev.device, &allocate, &set),
           "vkAllocateDescriptorSets material");
        return set;
    }

    // ---- Draws ----------------------------------------------------------------------------------

    /** A block in this frame's dynamic ring; its offset in the slot's uniform buffer. */
    uint32_t ringBlock(const void *data, size_t size) {
        const size_t at = size_t(alignUp(slot->ringUsed, uboAlign));
        if (at + size > ringBytes)
            return UINT32_MAX;
        slot->ringUsed = at + size;
        std::memcpy(slot->uniformBytes + ringOffset + at, data, size);
        return uint32_t(at);
    }

    void fillDraw(const DrawItem &it, DrawBlock &d, const float *lightViewProj) {
        const MaterialState &m = *it.material;
        std::copy(it.model, it.model + 16, d.model.m);
        if (lightViewProj)
            std::copy(lightViewProj, lightViewProj + 16, d.lightViewProj.m);
        copyMat3(it.normal, d.normalMatrix);
        copyMat3(m.mapTransform, d.mapTransform);
        copyMat3(m.alphaMapTransform, d.alphaMapTransform);
        copyMat3(m.emissiveMapTransform, d.emissiveMapTransform);
        d.color = {m.color[0], m.color[1], m.color[2], m.color[3]};
        d.specular = {m.specular[0], m.specular[1], m.specular[2], m.specular[3]};
        for (int i = 0; i < 5; i++)
            d.sky[i] = {m.skyUniforms[i][0], m.skyUniforms[i][1], m.skyUniforms[i][2],
                        m.skyUniforms[i][3]};
        std::copy(m.emissive, m.emissive + 3, d.emissive);
        d.alphaTest = m.alphaTest;
        d.metalRough[0] = m.metalness;
        d.metalRough[1] = m.roughness;
        d.spriteCenter[0] = it.spriteCenter[0];
        d.spriteCenter[1] = it.spriteCenter[1];
        d.receiveShadow = it.receiveShadow ? 1.0f : 0.0f;
        d.pointSize = m.pointSize * options.pointPixelScale;
        d.spriteRotation = m.rotation;
        d.pointQuad = pointQuads(it) ? 1 : 0;
    }

    struct Bound {
        VkPipeline pipeline = VK_NULL_HANDLE;
        VkDescriptorSet material = VK_NULL_HANDLE;
    };

    /** One draw (the GLES drawWithUniforms and submit). False when it had no pipeline yet. */
    bool draw(VkCommandBuffer cmd, const DrawItem &it, const ProgramKey &program,
              const PipelineState &state, const float *lightViewProj, Bound &bound) {
        const PipelineKey key = packKey(program.bits(), state);
        const Pipeline *p = pipeline(key, program, state);
        if (!p || !p->ready)
            return false;
        auto vb = buffers.find(it.vertices->serial);
        if (vb == buffers.end() || !vb->second.ready())
            return false;
        const Buffer *ib = nullptr, *instances = nullptr;
        if (it.indices) {
            auto f = buffers.find(it.indices->serial);
            if (f == buffers.end() || !f->second.ready())
                return false;
            ib = &f->second;
        }
        if (it.instances && !pointQuads(it)) {
            auto f = buffers.find(it.instances->serial);
            if (f == buffers.end() || !f->second.ready())
                return false;
            instances = &f->second;
        }
        DrawBlock block;
        fillDraw(it, block, lightViewProj);
        const uint32_t offset = ringBlock(&block, sizeof block);
        if (offset == UINT32_MAX) {
            if (!ringReported) {
                ringReported = true;
                fail("vulkan draw ring full: draws dropped this frame");
            }
            return false;
        }
        if (bound.pipeline != p->pipeline) {
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p->pipeline);
            bound.pipeline = p->pipeline;
        }
        const VkDescriptorSet material = materialSet(*it.material);
        if (bound.material != material) {
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout,
                                    kSetMaterial, 1, &material, 0, nullptr);
            bound.material = material;
        }
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, kSetDraw, 1,
                                &slot->drawSet, 1, &offset);
        if (state.depthBias)
            vkCmdSetDepthBias(cmd, it.material->polygonOffsetUnits, 0,
                              it.material->polygonOffsetFactor);
        const bool quads = pointQuads(it);
        // A quad array starts at the draw's first point (the GLES vao does the same), as instanced
        // draws of quads cannot start at a vertex.
        const VkDeviceSize vertexOffset = quads ? VkDeviceSize(it.first) * kVertexStride : 0;
        vkCmdBindVertexBuffers(cmd, 0, 1, &vb->second.buffer, &vertexOffset);
        if (instances) {
            const VkDeviceSize zero = 0;
            vkCmdBindVertexBuffers(cmd, 1, 1, &instances->buffer, &zero);
        }
        const VkDeviceSize zero = 0;
        vkCmdBindVertexBuffers(cmd, 2, 1, &defaults, &zero);
        const uint32_t instanceCount = it.instances && !quads ? it.instances->count : 1;
        if (quads) {
            vkCmdDraw(cmd, 4, it.count, 0, 0);
            stats.drawCalls++;
            stats.points += it.count;
            return true;
        }
        if (ib) {
            vkCmdBindIndexBuffer(cmd, ib->buffer, 0,
                                 it.indices->wide ? VK_INDEX_TYPE_UINT32 : VK_INDEX_TYPE_UINT16);
            vkCmdDrawIndexed(cmd, it.count, instanceCount, it.first, 0, 0);
        } else {
            vkCmdDraw(cmd, it.count, instanceCount, it.first, 0);
        }
        if (it.mode == DrawMode::LineLoop && it.count >= 2)
            closeLoop(cmd, it, instanceCount);
        stats.drawCalls++;
        const uint64_t n = uint64_t(it.count) * uint64_t(instanceCount);
        if (it.mode == DrawMode::Triangles)
            stats.triangles += uint32_t(n / 3);
        else if (it.mode == DrawMode::Points)
            stats.points += uint32_t(n);
        else
            stats.lines += uint32_t(it.mode == DrawMode::Lines ? n / 2 : n);
        return true;
    }

    /** GL_LINE_LOOP's last segment: a two-index strip from the last vertex back to the first. */
    void closeLoop(VkCommandBuffer cmd, const DrawItem &it, uint32_t instanceCount) {
        uint32_t pair[2] = {it.first + it.count - 1, it.first};
        if (it.indices) {
            auto found = loopClosures.find({it.indices->serial, it.first, it.count});
            if (found == loopClosures.end())
                return;
            pair[0] = found->second.first;
            pair[1] = found->second.second;
        }
        if (slot->closuresUsed + 2 > kClosureCapacity)
            return;
        const uint32_t first = slot->closuresUsed;
        slot->closureIndices[first] = pair[0];
        slot->closureIndices[first + 1] = pair[1];
        slot->closuresUsed += 2;
        vkCmdBindIndexBuffer(cmd, slot->closures, 0, VK_INDEX_TYPE_UINT32);
        vkCmdDrawIndexed(cmd, 2, instanceCount, first, 0, 0);
    }

    // ---- Shadow ---------------------------------------------------------------------------------

    void ensureShadowMap(int size) {
        if (shadowMap.image && shadowSize == size)
            return;
        if (shadowFramebuffer) {
            VkFramebuffer f = shadowFramebuffer;
            retire([this, f] { vkDestroyFramebuffer(dev.device, f, nullptr); });
            shadowFramebuffer = VK_NULL_HANDLE;
        }
        retireTexture(shadowMap);
        shadowMap =
            makeImage(size, size, shadowFormat, 1,
                      VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
                      VK_IMAGE_ASPECT_DEPTH_BIT);
        auto info = vkStruct<VkFramebufferCreateInfo>(VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO);
        info.renderPass = shadowPass;
        info.attachmentCount = 1;
        info.pAttachments = &shadowMap.view;
        info.width = info.height = uint32_t(size);
        info.layers = 1;
        vk(vkCreateFramebuffer(dev.device, &info, nullptr, &shadowFramebuffer),
           "vkCreateFramebuffer shadow");
        shadowSize = size;
        shadowHash = ~0ull;
        shadowDrawn = false;
    }

    /** As the GLES renderShadow: redrawn only when a caster, the light or a caster's map changed.
     */
    void renderShadow(VkCommandBuffer cmd, const RenderState &s) {
        ensureShadowMap(s.shadowMapSize);
        uint64_t hash = s.shadowHash;
        for (const DrawItem &it : s.items)
            if (it.depthKey.alphaTest && castsShadow(it)) {
                const Texture *map = it.material->map ? texture(it.material->map) : nullptr;
                const Texture *alpha =
                    it.material->alphaMap ? texture(it.material->alphaMap) : nullptr;
                hash = mix64(hash, map ? map->uid : 0);
                hash = mix64(hash, alpha ? alpha->uid : 0);
            }
        // Every caster's pipeline must exist, or the map would be drawn without it and kept.
        bool complete = true;
        for (const DrawItem &it : s.items) {
            if (!castsShadow(it))
                continue;
            const PipelineState ss = shadowState(it);
            const Pipeline *p = pipeline(packKey(it.depthKey.bits(), ss), it.depthKey, ss);
            complete &= (p && (p->ready || p->failed)) || failedPrograms.count(it.depthKey.bits());
        }
        if (hash == shadowHash || !complete)
            return;
        shadowHash = hash;
        VkClearValue clear{};
        clear.depthStencil = {1, 0};
        auto begin = vkStruct<VkRenderPassBeginInfo>(VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO);
        begin.renderPass = shadowPass;
        begin.framebuffer = shadowFramebuffer;
        begin.renderArea = {{0, 0}, {uint32_t(shadowSize), uint32_t(shadowSize)}};
        begin.clearValueCount = 1;
        begin.pClearValues = &clear;
        vkCmdBeginRenderPass(cmd, &begin, VK_SUBPASS_CONTENTS_INLINE);
        // Positive height: the map's rows are GL's, as its sampling expects (research/
        // vulkan-port.md 4.3); vk_scene_state.h inverts the winding for it.
        const VkViewport viewport{0, 0, float(shadowSize), float(shadowSize), 0, 1};
        const VkRect2D scissor{{0, 0}, {uint32_t(shadowSize), uint32_t(shadowSize)}};
        vkCmdSetViewport(cmd, 0, 1, &viewport);
        vkCmdSetScissor(cmd, 0, 1, &scissor);
        Mat4 lvp;
        std::copy(s.lightViewProj, s.lightViewProj + 16, lvp.begin());
        Frustum light = Frustum::fromViewProj(lvp);
        const uint32_t before = stats.drawCalls;
        Bound bound;
        for (const DrawItem &it : s.items) {
            if (!castsShadow(it) || !light.intersects(it.sphere))
                continue;
            draw(cmd, it, it.depthKey, shadowState(it), s.lightViewProj, bound);
        }
        vkCmdEndRenderPass(cmd);
        stats.shadowDrawCalls = stats.drawCalls - before;
        stats.shadowMapDraws = stats.shadowDrawCalls;
        stats.shadowRedraws++;
        shadowDrawn = true;
    }

    // ---- Frame ----------------------------------------------------------------------------------

    void beginFrame(uint64_t index, uint64_t completed) {
        // Everything frames up to `completed` used may go now.
        while (!retired.empty() && retired.front().first <= completed) {
            retired.front().second();
            retired.pop_front();
        }
        if (prepared) {
            windowMax = std::max(windowMax, prepareMs + drawMs);
            if (++windowFrames >= 90) {
                cpuMaxMs = windowMax;
                windowMax = 0;
                windowFrames = 0;
                cpuWindowDone = true;
            }
        }
        frameIndex = index;
        slot = &slots[size_t(index % slotCount)];
        // This slot's previous frame is among the completed ones: its GPU timer can be read.
        if (slot->queryPending) {
            uint64_t stamps[2] = {};
            if (vkGetQueryPoolResults(dev.device, slot->queries, 0, 2, sizeof stamps, stamps,
                                      sizeof(uint64_t), VK_QUERY_RESULT_64_BIT) == VK_SUCCESS) {
                const uint64_t mask =
                    dev.timestampValidBits >= 64 ? ~0ull : (1ull << dev.timestampValidBits) - 1;
                gpuMs = float(double((stamps[1] - stamps[0]) & mask) *
                              double(properties.limits.timestampPeriod) / 1e6);
            }
            slot->queryPending = false;
        }
        slot->ringUsed = slot->stagingUsed = 0;
        slot->closuresUsed = 0;
        slot->queryStarted = false;
        frame.beginFrame();
        prepareMs = drawMs = 0;
        stats.drawCalls = stats.shadowDrawCalls = stats.triangles = stats.points = stats.lines =
            stats.culledItems = 0;
        stats.uploadedBytesLastFrame = 0;
        prepared = false;
    }

    void prepareFrame(VkCommandBuffer cmd) {
        if (!slot)
            throw std::runtime_error("VkSceneRenderer::prepareFrame before beginFrame");
        const auto t0 = Clock::now();
        prepared = true;
        copies = false;
        recordInit(cmd);
        if (slot->queries && options.gpuTimer) {
            // Outside the render pass: a multiview pass would write one timestamp per view.
            vkCmdResetQueryPool(cmd, slot->queries, 0, 4);
            vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, slot->queries, 0);
            slot->queryStarted = true;
        }
        work.start(t0, options.uploadBytesPerFrame, options.programLinksPerFrame,
                   options.prepareBudgetMs);
        pollPipelines();
        // Draws of the last frame asked for these; build them now.
        for (const PipelineKey &key : wanted) {
            auto found = pendingPrograms.find(key);
            if (found != pendingPrograms.end())
                request(key, found->second.first, found->second.second);
        }
        wanted.clear();
        pendingPrograms.clear();
        // Geometry first: a state waits for its buffers, while textures may arrive a little later.
        adopt(cmd);
        pumpTextures(cmd);
        const RenderState *s = current.get();
        if (pending)
            warm(*pending);
        if (s)
            warm(*s);
        if (copies) {
            // [VK-SYNC] "Upload data from the CPU to a vertex buffer": transfer writes before
            // vertex input and index reads of this frame's passes.
            auto barrier = vkStruct<VkMemoryBarrier>(VK_STRUCTURE_TYPE_MEMORY_BARRIER);
            barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
            barrier.dstAccessMask = VK_ACCESS_VERTEX_ATTRIBUTE_READ_BIT | VK_ACCESS_INDEX_READ_BIT;
            vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT,
                                 VK_PIPELINE_STAGE_VERTEX_INPUT_BIT, 0, 1, &barrier, 0, nullptr, 0,
                                 nullptr);
        }
        if (s && s->shadow && options.shadows && s->shadowMapSize > 0)
            renderShadow(cmd, *s);
        if (s) {
            std::memcpy(slot->uniformBytes + frameBlockOffset, &s->frame, sizeof s->frame);
            std::memcpy(slot->uniformBytes + skyBlockOffset, &s->sky, sizeof s->sky);
        }
        bindShadow(*slot, s && s->shadow && options.shadows && shadowDrawn ? shadowMap.view
                                                                           : fallbackShadow.view);
        prepareMs = std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
    }

    VkClearColorValue clearColor() const {
        VkClearColorValue c{{0, 0, 0, 1}};
        const RenderState *s = current.get();
        if (s && s->hasBackground)
            for (int i = 0; i < 3; i++)
                c.float32[i] = target.srgb ? s->background[i] : srgbEncode(s->background[i]);
        return c;
    }

    void render(VkCommandBuffer cmd, const SceneEye *eyes, uint32_t width, uint32_t height,
                SceneDrawSet set) {
        const auto t0 = Clock::now();
        const RenderState *s = current.get();
        if (!s || !slot || !target.renderPass)
            return;
        drawing = true;
        // View block: slot i is eye i (multiview), as the GLES writeViewUbos.
        ViewBlock v;
        for (int i = 0; i < 2; i++) {
            Mat4 view, proj, inv;
            std::copy(eyes[i].view, eyes[i].view + 16, view.begin());
            std::copy(eyes[i].projection, eyes[i].projection + 16, proj.begin());
            const Mat4 vp = multiply(proj, view);
            if (!invert(view, inv))
                inv = identity();
            std::copy(vp.begin(), vp.end(), v.viewProj[i].m);
            std::copy(view.begin(), view.end(), v.view[i].m);
            std::copy(proj.begin(), proj.end(), v.proj[i].m);
            v.cameraPos[i] = {inv[12], inv[13], inv[14], 1};
        }
        v.viewport = {float(height), float(height) * 0.5f, 0, 0};
        const uint32_t viewOffset = ringBlock(&v, sizeof v);
        if (viewOffset == UINT32_MAX) {
            drawing = false;
            return;
        }
        frame.buildLists(*s, eyes, 2, true, *this, set);
        stats.attachedPlaced = frame.attachedPlaced();
        stats.culledItems = frame.culledItems();
        // Negative height (Vulkan 1.1 core, VK_KHR_maintenance1): NDC +y is image row 0, the top
        // of an OpenXR Vulkan image, with GL matrices and GL winding (research/vulkan-port.md 4.3).
        const VkViewport viewport{0, float(height), float(width), -float(height), 0, 1};
        const VkRect2D scissor{{0, 0}, {width, height}};
        vkCmdSetViewport(cmd, 0, 1, &viewport);
        vkCmdSetScissor(cmd, 0, 1, &scissor);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, kSetFrame, 1,
                                &slot->frameSet, 1, &viewOffset);
        Bound bound;
        for (const SceneDraw &d : frame.opaque())
            draw(cmd, *d.item, worldProgram(*d.item), worldState(*d.item), nullptr, bound);
        for (const SceneDraw &d : frame.transparent())
            draw(cmd, *d.item, worldProgram(*d.item), worldState(*d.item), nullptr, bound);
        drawing = false;
        drawMs += std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
        publishStats();
    }

    void endFrame(VkCommandBuffer cmd) {
        if (slot && slot->queryStarted) {
            vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, slot->queries, 1);
            slot->queryPending = true;
            slot->queryStarted = false;
        }
    }

    void publishStats() {
        const RenderState *s = current.get();
        stats.prepareMs = prepareMs;
        stats.drawMs = drawMs;
        stats.cpuMs = prepareMs + drawMs;
        stats.cpuMaxMs = cpuWindowDone ? cpuMaxMs : std::max(windowMax, stats.cpuMs);
        stats.gpuMs = gpuMs;
        stats.pendingUploads = uint32_t(uploads.size());
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
        uint32_t ready = 0;
        for (const auto &[key, p] : pipelines)
            ready += p.ready;
        stats.programs = ready; // pipelines, the Vulkan counterpart of linked programs
        stats.programsCompiling = uint32_t(pendingBuilds());
        stats.programsFailed = programsFailed;
        stats.buffers = uint32_t(buffers.size());
        stats.vertexArrays = 0;
        std::lock_guard<std::mutex> lock(statsMutex);
        frameStats = stats;
    }

    void savePipelineCache() {
        if (!pipelineCache || cachePath.empty())
            return;
        size_t size = 0;
        if (vkGetPipelineCacheData(dev.device, pipelineCache, &size, nullptr) != VK_SUCCESS ||
            !size)
            return;
        std::vector<char> data(size);
        if (vkGetPipelineCacheData(dev.device, pipelineCache, &size, data.data()) != VK_SUCCESS)
            return;
        const std::string staged = cachePath + ".tmp";
        {
            std::ofstream out(staged, std::ios::binary | std::ios::trunc);
            out.write(data.data(), std::streamsize(size));
            if (!out)
                return;
        }
        if (std::rename(staged.c_str(), cachePath.c_str()) == 0)
            VK_SCENE_LOG("vulkan pipeline cache saved (%zu bytes)", size);
    }

    void destroy() {
        if (!dev.device)
            return;
        {
            std::lock_guard<std::mutex> lock(workMutex);
            stopping = true;
        }
        workReady.notify_all();
        modulesReady.notify_all();
        for (auto &t : workers)
            t.join();
        workers.clear();
        for (auto &r : results)
            if (r.pipeline)
                vkDestroyPipeline(dev.device, r.pipeline, nullptr);
        results.clear();
        // The caller made the device idle: every retired object may go.
        while (!retired.empty()) {
            retired.front().second();
            retired.pop_front();
        }
        for (auto &[key, p] : pipelines)
            if (p.pipeline)
                vkDestroyPipeline(dev.device, p.pipeline, nullptr);
        pipelines.clear();
        for (auto &[bits, m] : modules) {
            if (m.vertex)
                vkDestroyShaderModule(dev.device, m.vertex, nullptr);
            if (m.fragment)
                vkDestroyShaderModule(dev.device, m.fragment, nullptr);
        }
        modules.clear();
        for (auto &[serial, b] : buffers)
            if (b.buffer)
                vmaDestroyBuffer(allocator, b.buffer, b.allocation);
        buffers.clear();
        for (auto &[id, t] : textures)
            destroyTexture(t);
        textures.clear();
        for (auto &j : uploads)
            destroyTexture(j.tex);
        uploads.clear();
        for (Texture *t : {&white, &clearTex, &fallbackShadow, &shadowMap})
            destroyTexture(*t);
        if (shadowFramebuffer)
            vkDestroyFramebuffer(dev.device, shadowFramebuffer, nullptr);
        if (shadowPass)
            vkDestroyRenderPass(dev.device, shadowPass, nullptr);
        materialSets.clear();
        for (VkDescriptorPool pool : materialPools)
            vkDestroyDescriptorPool(dev.device, pool, nullptr);
        materialPools.clear();
        for (Slot &s : slots) {
            if (s.uniforms)
                vmaDestroyBuffer(allocator, s.uniforms, s.uniformAllocation);
            if (s.staging)
                vmaDestroyBuffer(allocator, s.staging, s.stagingAllocation);
            if (s.closures)
                vmaDestroyBuffer(allocator, s.closures, s.closureAllocation);
            if (s.queries)
                vkDestroyQueryPool(dev.device, s.queries, nullptr);
        }
        slots.clear();
        if (slotPool)
            vkDestroyDescriptorPool(dev.device, slotPool, nullptr);
        if (defaults)
            vmaDestroyBuffer(allocator, defaults, defaultsAllocation);
        for (auto &[setup, s] : samplers)
            vkDestroySampler(dev.device, s, nullptr);
        samplers.clear();
        if (shadowSampler)
            vkDestroySampler(dev.device, shadowSampler, nullptr);
        if (pipelineLayout)
            vkDestroyPipelineLayout(dev.device, pipelineLayout, nullptr);
        for (VkDescriptorSetLayout &l : setLayouts)
            if (l)
                vkDestroyDescriptorSetLayout(dev.device, l, nullptr);
        if (pipelineCache)
            vkDestroyPipelineCache(dev.device, pipelineCache, nullptr);
        if (allocator)
            vmaDestroyAllocator(allocator);
        allocator = nullptr;
        dev = VkSceneDevice{};
        initialized = false;
    }
};

// ---- Public API ---------------------------------------------------------------------------------

VkSceneRenderer::VkSceneRenderer()
    : VkSceneRenderer([] {
          SceneRendererOptions options;
          options.multiview = true;
          return options;
      }()) {}

VkSceneRenderer::VkSceneRenderer(const SceneRendererOptions &options)
    : impl_(std::make_unique<Impl>(options)) {}

VkSceneRenderer::~VkSceneRenderer() { impl_->destroy(); }

bool VkSceneRenderer::initialize(const VkSceneDevice &device, uint32_t frameSlots,
                                 const std::string &pipelineCachePath) {
    try {
        return impl_->init(device, frameSlots, pipelineCachePath);
    } catch (const std::exception &error) {
        impl_->fail(std::string("vulkan scene renderer: ") + error.what());
        return false;
    }
}

void VkSceneRenderer::releaseTarget() { impl_->releaseTarget(); }

void VkSceneRenderer::setTarget(const VkSceneTarget &target) {
    if (impl_->initialized)
        impl_->setTarget(target);
}

bool VkSceneRenderer::enqueueJson(std::string_view text) { return impl_->stream.enqueueJson(text); }
bool VkSceneRenderer::enqueue(nlohmann::json &&j) { return impl_->stream.enqueue(std::move(j)); }
void VkSceneRenderer::tick() { impl_->stream.tick(); }
bool VkSceneRenderer::acceptsPackets() const { return impl_->stream.acceptsPackets(); }
bool VkSceneRenderer::takeResetRequest() { return impl_->stream.takeResetRequest(); }
std::string VkSceneRenderer::lastError() const { return impl_->stream.lastError(); }

void VkSceneRenderer::beginFrame(uint64_t frame, uint64_t completed) {
    if (impl_->initialized)
        impl_->beginFrame(frame, completed);
}

void VkSceneRenderer::prepareFrame(VkCommandBuffer cmd) {
    if (impl_->initialized)
        impl_->prepareFrame(cmd);
}

void VkSceneRenderer::setControllerPoses(const SceneControllerPoses &poses) {
    if (impl_->initialized)
        impl_->frame.setControllerPoses(poses, impl_->current.get());
}

unsigned VkSceneRenderer::attachedHands() const {
    return impl_->initialized ? impl_->frame.attachedHands() : 0;
}

size_t VkSceneRenderer::attachedBounds(float (*out)[4], size_t max) const {
    return impl_->initialized ? impl_->frame.attachedBounds(out, max) : 0;
}

VkClearColorValue VkSceneRenderer::clearColor() const { return impl_->clearColor(); }

void VkSceneRenderer::render(VkCommandBuffer cmd, const SceneEye eyes[2], uint32_t width,
                             uint32_t height, SceneDrawSet set) {
    if (impl_->initialized)
        impl_->render(cmd, eyes, width, height, set);
}

void VkSceneRenderer::endFrame(VkCommandBuffer cmd) {
    if (impl_->initialized)
        impl_->endFrame(cmd);
}

SceneStats VkSceneRenderer::stats() const {
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

void VkSceneRenderer::savePipelineCache() {
    if (impl_->initialized)
        impl_->savePipelineCache();
}

} // namespace office
