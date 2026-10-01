// Draws the office's three.js scene natively with OpenGL ES 3, from the packet stream that the
// page's NativeScene (src/client/native/scene.ts) sends. Bridge threads call enqueue*; the GL
// thread calls initialize, prepareFrame, render/renderStereo, renderSharpScreens and the
// destructor. Its bridge side (SceneStream, scene_stream.h) and frame planning
// (SceneFramePlanner, scene_frame.h) are GL-free and shared with the other world renderers.
// See docs/vr-native-android.md.
#pragma once

#include "scene_frame.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace office {

struct SceneRendererOptions {
    bool multiview = false; // GL_OVR_multiview2: renderStereo draws both views in one pass
    bool srgbFramebuffer =
        true;          // true: target is GL_SRGB8_ALPHA8 (hardware encodes); false: shader encodes
    bool clear = true; // clear color (scene background) + depth before drawing
    bool shadows = true;                // the moon's shadow map, as three renders it
    size_t maxPacketBytes = 64u << 20;  // one JSON packet
    size_t maxQueuedBytes = 192u << 20; // decoded texture data waiting for the GL thread
    // prepareFrame work per frame: it stops starting new uploads, links and vertex arrays once
    // either limit is reached (at least one piece of work always runs, so everything arrives).
    size_t uploadBytesPerFrame = 2u << 20; // buffer + texture bytes
    float prepareBudgetMs = 2.0f;          // CPU time
    int textureUploadsPerFrame = 2;        // textures started per frame
    int programLinksPerFrame =
        2; // programs started per frame (compiled in the background
           // with GL_KHR_parallel_shader_compile, else checked a frame later)
    float staticAfterSeconds = 1.5f; // unchanged this long -> merged into a static batch
    float pointPixelScale = 1.0f;    // three's pixelRatio: PointsMaterial.size is multiplied by it
    bool gpuTimer = true;            // GL_EXT_disjoint_timer_query GPU time in stats (when present)
    int gpuTimerInterval =
        30; // measure one frame in this many (a query every frame costs a flush on some drivers)
    bool checkGlErrors = false; // glGetError after prepare and render (a sync point; host tests)
    // renderSharpScreens: screens farther than this from the nearest eye (to their bounding
    // sphere) keep only their world rendering; at most sharpMaxScreens are drawn, nearest first.
    float sharpMaxDistance = 6.0f;
    int sharpMaxScreens = 16;
    int sharpMaxOverlays = 64; // see-through surfaces redrawn over the screens, nearest first
    // World depth texels of slope the screen occlusion test tolerates (MSAA resolve, foveated
    // periphery at minimum density 0.25), capped at sharpMaxSlopeMeters.
    float sharpDepthSlack = 4.0f;
    float sharpMaxSlopeMeters = 0.06f;
    // planSharpScreens: present only the pixels the screens can cover (false: the whole image, for
    // comparisons). Resolution, projection and occlusion are the same either way.
    bool sharpCropToScreens = true;
};

/** The world pass's depth, which renderSharpScreens samples to keep what is in front. */
struct SharpScreenDepth {
    uint32_t texture = 0;      // GL depth texture of the world pass, contents preserved
    bool arrayTexture = false; // GL_TEXTURE_2D_ARRAY (multiview) or GL_TEXTURE_2D
    int layer = 0;             // array layer for a single-view call (multiview uses the view index)
    // x, y, width, height: where the high-resolution viewport ([0,1]^2) lies in the depth
    // texture's coordinates (the world eye rect divided by the texture size).
    float uvRect[4] = {0, 0, 1, 1};
};

class SceneRenderer {
  public:
    explicit SceneRenderer(const SceneRendererOptions &options = {});
    ~SceneRenderer(); // GL thread, context current
    SceneRenderer(const SceneRenderer &) = delete;
    SceneRenderer &operator=(const SceneRenderer &) = delete;

    /** GL thread, context current. False when a required extension is missing; see lastError(). */
    bool initialize();

    // ---- Bridge thread (calls are serialized internally; they never wait for the GL thread)
    // ------
    /**
     * A Packet, or the frame() envelope `{scene, control, panel}` (only `scene` is read). A null
     * scene still runs the static batcher. False when the packet was rejected (see lastError).
     */
    bool enqueueJson(std::string_view json);
    bool enqueue(nlohmann::json &&packet);
    /** Runs the static batcher without a packet (enqueueJson with a null scene does the same). */
    void tick();
    /** False under backpressure: pull with {skipScene: true} until it is true again. */
    bool acceptsPackets() const;
    /** True once after a rejected packet or a seq gap: the next pull passes {sceneReset: true}. */
    bool takeResetRequest();

    // ---- GL thread ------------------------------------------------------------------------------
    /**
     * Once per frame, before the eye framebuffer is bound (it may be called with any framebuffer
     * bound). Takes the newest scene state, uploads buffers and textures, starts and finishes
     * program links, and redraws the shadow map when it changed, all within the frame budget.
     * Restores the draw and read framebuffer bindings and the viewport it found. When it was never
     * called, render/renderStereo run it themselves (in the eye framebuffer, which then must be
     * restored too).
     */
    void prepareFrame();
    /**
     * The grips this frame's render calls attach objects to, after prepareFrame (which forgets the
     * previous frame's, so a frame without this call hides every attached object). Only matrices
     * are recomposed: no upload, allocation or program change. A non-finite or non-rigid grip is
     * treated as invalid.
     */
    void setControllerPoses(const SceneControllerPoses &poses);
    // render/renderStereo draw into the bound draw framebuffer and viewport, and leave: no program
    // or vertex array bound, GL_ARRAY_BUFFER 0, blend/cull/polygon offset off, depth test on with
    // LEQUAL and writes on, full color mask, front face CCW, active texture unit 0. Texture units
    // 0-4 and uniform buffer bindings 0-2 are left bound to the renderer's objects. With
    // options.clear they clear color (the scene background) and depth first. Several calls after
    // one prepareFrame (the two eyes without multiview) draw the same state and add up in stats.
    /** One view (single-view programs). */
    void render(const SceneEye &eye, int viewportHeightPx);
    /**
     * Both eyes. Multiview: one pass into the bound 2-layer framebuffer, bindEye is not called.
     * Otherwise bindEye(0), draw eye 0, bindEye(1), draw eye 1, from the same scene snapshot.
     */
    void renderStereo(const SceneEye eyes[2], int viewportHeightPx,
                      const std::function<void(int eye)> &bindEye = {});

    // ---- GL thread: the high-resolution laptop screen layer -------------------------------------
    // Laptop screens (materials the page tags sharpText) are drawn a second time, from the same
    // texture, geometry and matrices, into a separate unfoveated high-resolution target that the
    // caller composites over the world. The world draw is unchanged and remains the fallback.
    /** A tagged screen in the drawn state has its texture resident and a program linked. */
    bool hasSharpScreens() const;
    /**
     * As above, for a screen within sharpMaxDistance of either eye and inside either eye's frustum,
     * whose program for this depth texture kind is linked. Pass both eyes, also for two-pass mono.
     */
    bool hasSharpScreens(const SceneEye eyes[2], bool arrayDepth) const;
    /**
     * After the world pass of the same eyes. Clears the bound draw framebuffer's color (scissor
     * applies) to (0,0,0,0), then draws the screens, with the depth test off and no depth writes:
     * a screen fragment is dropped where `depth` holds a nearer surface. Covered pixels are
     * premultiplied (color * (1 - fade), 1). See-through surfaces that do not write world depth
     * (glass, sprites) are then blended over the screens, where they lie in front of them.
     * Multiview: one pass of both eyes into the bound 2-layer framebuffer, `depth` must be an
     * array. Otherwise eyes[0] only, sampling the 2D depth or depth.layer. The viewport is (0, 0,
     * viewportWidth, viewportHeight) and must be bound. Never compiles or uploads: prepareFrame
     * links these programs within its budget and screens without one are skipped. Leaves the
     * render() state, with texture unit 5 unbound.
     */
    void renderSharpScreens(const SceneEye eyes[2], int viewportWidth, int viewportHeight,
                            const SharpScreenDepth &depth, float fade);
    /**
     * The cropped layer, step 1: once per frame after prepareFrame, with both eyes and each view's
     * whole high-resolution image size (multiview: equal). Chooses the screens and overlays as the
     * whole-image call does and fills `plan`: the pixels of each view the screens can cover
     * (viewRect, from their vertex box through their model matrix) and the pixels to clear and draw
     * (region). Returns plan.any; without it, submit no layer this frame. Present viewRect with
     * sharpSubTangents of the view's tangents, so every pixel keeps its whole-image position.
     */
    bool planSharpScreens(const SceneEye eyes[2], const int width[2], const int height[2],
                          bool arrayDepth, SharpScreenPlan &plan);
    /**
     * The cropped layer, step 2: after the world pass, into the bound framebuffer of the view's
     * whole image (multiview: both layers, view ignored; else view 0 or 1). Sets the viewport to
     * the whole image, invalidates the color attachment, clears region to (0,0,0,0) and draws the
     * screens and overlays inside viewRect, exactly as the whole-image call would there. Pixels
     * outside region are undefined afterwards and must not be presented. The caller's scissor
     * further limits it. `plan` must be this frame's latest planSharpScreens (else it clears, draws
     * nothing and reports lastError once). Restores the caller's viewport and scissor and leaves
     * the render() state, with texture unit 5 unbound.
     */
    void renderSharpScreens(const SharpScreenPlan &plan, int view, const SharpScreenDepth &depth,
                            float fade);

    // ---- Any thread -----------------------------------------------------------------------------
    /** The page camera's world matrix (column-major) from the latest state; false before any. */
    bool cameraWorld(float out[16]) const;
    SceneStats stats() const;
    std::string lastError() const;

    struct Impl;

  private:
    std::unique_ptr<Impl> impl_;
};

} // namespace office
