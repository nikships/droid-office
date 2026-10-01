// Draws the office's scene with Vulkan from the same packet stream and frame plan as the GLES
// SceneRenderer (research/vulkan-port.md 4.5, option b: a parallel renderer sharing the GL-free
// code). Bridge threads call enqueue*; the render thread records every GPU command into command
// buffers the caller submits: it never submits, waits or presents itself, so it runs on the
// OpenXR session's queue (world_vk.cpp) and on a host lavapipe device alike
// (app/src/test/cpp/vk/render.cpp). Its bridge side is the shared SceneStream (scene_stream.h) and
// its culling, draw order and controller attachments the shared SceneFramePlanner
// (scene_frame.h).
//
// GPU side: programs are the generator's Vulkan dialect (scene_shaders.h), compiled to SPIR-V with
// libshaderc and turned into pipelines by worker threads behind a VkPipelineCache that persists
// between launches; draws never start a build, and a state is drawn only once every pipeline it
// needs exists, as the GLES renderer waits for its programs. Buffers and textures go up through
// per-frame staging within the GLES budgets (SceneRendererOptions); descriptors follow update
// frequency (scene_uniforms.h: set 0 per frame, set 1 per material, set 2 a dynamic Draw block);
// the moon's shadow map is its own depth pass, redrawn only when it changed.
#pragma once

#include "scene_frame.h"
#include "scene_renderer.h"

#include <vulkan/vulkan.h>

#include <memory>
#include <string>
#include <string_view>

namespace office {

/** The device the renderer records for. The caller owns every handle and keeps them alive. */
struct VkSceneDevice {
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    VkDevice device = VK_NULL_HANDLE;
    uint32_t apiVersion = VK_API_VERSION_1_1; // the instance's and device's, at least 1.1
    bool samplerAnisotropy = false;           // the feature is enabled on the device
    bool largePoints = false;                 // the feature is enabled on the device
    uint32_t timestampValidBits = 0;          // of the queue family the command buffers run on
};

/**
 * The world pass the renderer's pipelines are made for: subpass 0 of `renderPass`, a multiview
 * pass with view mask 0b11, a colour attachment of the colour format (sRGB when `srgb`) and a depth
 * attachment, both with `samples`. `compatibility` names the pass's structure: a pass with another
 * value is not render-pass compatible (Vulkan "Render Pass Compatibility"), so the world pipelines
 * are rebuilt for it.
 */
struct VkSceneTarget {
    VkRenderPass renderPass = VK_NULL_HANDLE;
    VkSampleCountFlagBits samples = VK_SAMPLE_COUNT_1_BIT;
    bool srgb = true;
    uint64_t compatibility = 0;
};

class VkSceneRenderer {
  public:
    /** The installed path: multiview and an sRGB target by default. */
    VkSceneRenderer();
    explicit VkSceneRenderer(const SceneRendererOptions &options);
    /** Render thread. The device must be idle (no command buffer of the renderer pending). */
    ~VkSceneRenderer();
    VkSceneRenderer(const VkSceneRenderer &) = delete;
    VkSceneRenderer &operator=(const VkSceneRenderer &) = delete;

    /**
     * Render thread. `frameSlots` frames may be in flight (the uniform and staging rings);
     * `pipelineCachePath` (may be empty) is read now and written by savePipelineCache. False when
     * a required device capability is missing; see lastError().
     */
    bool initialize(const VkSceneDevice &device, uint32_t frameSlots,
                    const std::string &pipelineCachePath = {});
    /** Render thread, before the first render and whenever the world pass is recreated. */
    void setTarget(const VkSceneTarget &target);
    /** Render thread, before destroying the old render pass. Wait for its pipeline builds. */
    void releaseTarget();

    // ---- Bridge thread (as SceneRenderer) -------------------------------------------------------
    bool enqueueJson(std::string_view json);
    bool enqueue(nlohmann::json &&packet);
    void tick();
    bool acceptsPackets() const;
    bool takeResetRequest();
    /** Any thread. The last error (packet, shader, pipeline or device), or empty. */
    std::string lastError() const;

    // ---- Render thread, each frame in this order ------------------------------------------------
    /**
     * `frame` counts up by one per frame and selects the frame slot (frame % frameSlots). Every
     * command buffer recorded for frames up to and including `completed` has finished executing:
     * the renderer then frees what those frames last used and reuses their slot.
     */
    void beginFrame(uint64_t frame, uint64_t completed);
    /**
     * Records into `cmd`, outside any render pass: the GPU timer's start, buffer and texture
     * uploads within the frame budget, and the shadow pass when the shadow map changed. Takes the
     * newest state once everything it draws with is on the GPU and has a pipeline.
     */
    void prepareFrame(VkCommandBuffer cmd);
    /** As SceneRenderer::setControllerPoses, after prepareFrame. */
    void setControllerPoses(const SceneControllerPoses &poses);
    unsigned attachedHands() const;
    size_t attachedBounds(float (*out)[4], size_t max) const;
    /** The world pass's colour clear value: the scene background, for vkCmdBeginRenderPass. */
    VkClearColorValue clearColor() const;
    /**
     * Inside subpass 0 of the target's render pass, which `cmd` has begun with a width x height
     * render area: both views in one multiview draw. Sets its own viewport (negative height:
     * research/vulkan-port.md 4.3), scissor, pipelines and descriptor sets. A World and an
     * Attached call in one pass draw the world and then the controller-attached items over it.
     */
    void render(VkCommandBuffer cmd, const SceneEye eyes[2], uint32_t width, uint32_t height,
                SceneDrawSet set = SceneDrawSet::All);
    /** After the world pass ends: the GPU timer's end. */
    void endFrame(VkCommandBuffer cmd);
    /** Any thread. */
    SceneStats stats() const;
    /** Render thread, the device idle: writes the pipeline cache to pipelineCachePath. */
    void savePipelineCache();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace office
