// Draws the office's three.js scene natively with OpenGL ES 3, from the packet stream that the
// page's NativeScene (src/client/native/scene.ts) sends. Bridge threads call enqueue*; the GL
// thread calls initialize, prepareFrame, render/renderStereo, renderSharpScreens and the
// destructor. See docs/vr-native-android.md.
#pragma once

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

/**
 * The display frame's controller grips for objects the page attaches to them (wire ObjectItem
 * hand): grip[h] is the grip's scene-world matrix (rig * tracked grip pose), column-major, rigid.
 * An attached object draws at grip[h] * its grip-relative matrix, and not at all unless valid[h];
 * one marked gripHeld (wire ObjectItem gripHeld) also needs held[h], this frame's squeeze.
 */
struct SceneControllerPoses {
    float grip[2][16] = {{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1},
                         {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};
    bool valid[2] = {false, false};
    bool held[2] = {false, false};
};

/**
 * Which items a render call draws. While the workspace panel is composited beneath the world
 * layer (office_xr.cpp), the world is drawn first, the panel's hole is cut into it, and the
 * controller-attached objects are drawn after the hole, so a held gun stays in front of the panel.
 */
enum class SceneDrawSet : uint8_t {
    All,      // every item; clears first with options.clear
    World,    // every item but the controller-attached ones; clears first with options.clear
    Attached, // only the controller-attached items, over what is there: never clears
};

struct SceneEye {         // column-major, OpenGL clip conventions
    float view[16];       // world -> eye
    float projection[16]; // eye -> clip
};

/**
 * One frame's screen layer, from planSharpScreens: which pixels of each view's high-resolution
 * image hold screens, and which pixels renderSharpScreens clears and draws. Rectangles are x, y,
 * width, height in GL window pixels (bottom-left origin), inside the view's width x height image.
 */
struct SharpScreenPlan {
    bool any = false;        // at least one screen is drawn; false: submit no layer this frame
    bool arrayDepth = false; // the depth texture kind the programs were chosen for
    int width[2] = {}, height[2] = {}; // each view's whole image (multiview: equal)
    SceneEye eyes[2] = {};             // the whole-image eyes the plan was made for
    // The pixels to present for each view: every pixel a planned screen can cover, with a pixel of
    // margin (a few transparent pixels for a view that sees none of them).
    int viewRect[2][4] = {};
    // Cleared and drawn: viewRect plus a transparent guard band for the compositor's filtering.
    // Multiview draws both views in one pass, so both regions are the union of the two.
    int region[2][4] = {};
    uint64_t token = 0; // internal: identifies the renderer's screen and overlay lists
};

/** Pixels in the band kept transparent around a plan's viewRect (bilinear bleed is one pixel). */
constexpr int kSharpGuardPixels = 4;

/** Tangents of a view's image edges (left and down negative for a view centred on its axis). */
struct SharpTangents {
    float left = -1, right = 1, down = -1, up = 1;
};

/**
 * The tangents that the pixel rectangle `rect` (x, y, width, height, bottom-left origin) of a
 * width x height image spans, when the whole image spans `full`. A projection is linear in the
 * tangent, so presenting `rect` with these edges places every pixel exactly where it lies in the
 * whole image.
 */
inline SharpTangents sharpSubTangents(const SharpTangents &full, int width, int height,
                                      const int rect[4]) {
    // (1 - t) * a + t * b is exact at both ends, so the whole image keeps the located edges.
    auto lerp = [](float a, float b, int at, int size) {
        const double t = double(at) / double(size);
        return float((1.0 - t) * double(a) + t * double(b));
    };
    return {lerp(full.left, full.right, rect[0], width),
            lerp(full.left, full.right, rect[0] + rect[2], width),
            lerp(full.down, full.up, rect[1], height),
            lerp(full.down, full.up, rect[1] + rect[3], height)};
}

/**
 * The depth texels (x, y, width, height) renderSharpScreens can sample for view `view` of `plan`,
 * with depth.uvRect mapping the view's image into a depthWidth x depthHeight texture, plus a
 * two-texel margin, clipped to the texture. The world depth outside it is never read.
 */
inline void sharpDepthRegion(const SharpScreenPlan &plan, int view, const float uvRect[4],
                             int depthWidth, int depthHeight, int out[4]) {
    const int *r = plan.region[view];
    const float kx = uvRect[2] * float(depthWidth) / float(plan.width[view]);
    const float ky = uvRect[3] * float(depthHeight) / float(plan.height[view]);
    const float bx = uvRect[0] * float(depthWidth), by = uvRect[1] * float(depthHeight);
    int x0 = int(std::floor(bx + kx * float(r[0]))) - 2;
    int y0 = int(std::floor(by + ky * float(r[1]))) - 2;
    int x1 = int(std::ceil(bx + kx * float(r[0] + r[2]))) + 2;
    int y1 = int(std::ceil(by + ky * float(r[1] + r[3]))) + 2;
    x0 = std::max(0, x0);
    y0 = std::max(0, y0);
    x1 = std::min(depthWidth, x1);
    y1 = std::min(depthHeight, y1);
    out[0] = x0;
    out[1] = y0;
    out[2] = std::max(0, x1 - x0);
    out[3] = std::max(0, y1 - y0);
}

/**
 * Up to four non-empty rectangles (x, y, width, height) that tile a width x height image except
 * `keep`; returns how many. An empty `keep` yields the whole image.
 */
inline int sharpComplement(const int keep[4], int width, int height, int out[4][4]) {
    int x0 = std::max(0, std::min(width, keep[0])), y0 = std::max(0, std::min(height, keep[1]));
    int x1 = std::max(x0, std::min(width, keep[0] + keep[2]));
    int y1 = std::max(y0, std::min(height, keep[1] + keep[3]));
    if (x0 == x1 || y0 == y1) {
        x0 = x1 = 0;
        y0 = y1 = height;
    }
    const int rects[4][4] = {{0, 0, width, y0},
                             {0, y1, width, height - y1},
                             {0, y0, x0, y1 - y0},
                             {x1, y0, width - x1, y1 - y0}};
    int n = 0;
    for (const auto &r : rects)
        if (r[2] > 0 && r[3] > 0) {
            std::copy(r, r + 4, out[n]);
            n++;
        }
    return n;
}

struct SceneStats {
    // Last frame. Draw calls include the shadow pass; multiview counts both views once.
    uint32_t drawCalls = 0, shadowDrawCalls = 0, triangles = 0, points = 0, lines = 0;
    uint32_t shadowMapDraws = 0; // draws in the latest shadow map redraw (it redraws only when a
                                 // caster or the light changed)
    uint64_t shadowRedraws = 0;  // shadow map redraws since initialize
    uint32_t drawItems = 0, culledItems = 0; // items in the drawn state; culled
    uint32_t objects = 0, visibleObjects = 0, staticBatches = 0, batchedObjects = 0,
             dynamicObjects = 0;
    uint32_t geometries = 0, materials = 0, textures = 0, programs = 0, buffers = 0,
             vertexArrays = 0;
    uint32_t programsCompiling = 0, programsFailed = 0;
    uint32_t queuedTextureOps = 0; // waiting for the GL thread
    uint64_t queuedBytes = 0;      // decoded texture bytes queued + blob parts being assembled
    uint32_t pendingUploads = 0;   // textures being uploaded in bands
    bool waitingState = false;     // a newer state is uploading (the previous one is still drawn)
    uint64_t uploadedBytesLastFrame = 0;
    uint64_t packetsApplied = 0, packetsRejected = 0, commits = 0;
    uint32_t unsupported = 0;
    // GL thread CPU time of the last frame: prepareFrame, render calls, and their sum. cpuMaxMs is
    // the worst frame of the last complete window of 90 frames.
    float prepareMs = 0, drawMs = 0, cpuMs = 0, cpuMaxMs = 0;
    float gpuMs = -1; // GPU time from prepareFrame to the end of the last render of a measured
                      // frame (-1: no timer)
    // Bridge thread, last packet: JSON parse (enqueueJson only) and model apply + publish.
    float parseMs = 0, applyMs = 0,
          applyMaxMs = 0; // applyMaxMs: worst apply since the previous stats() call window
    uint64_t sceneSeq = 0;
    uint64_t stateSerial = 0; // the drawn state (0 until the first one is on the GPU)
    // renderSharpScreens this frame, summed over its calls. Not part of drawCalls, triangles,
    // drawMs or cpuMs; gpuMs of a measured frame includes it.
    uint32_t sharpScreens = 0, sharpOverlays = 0, sharpDrawCalls = 0;
    uint32_t sharpItems = 0; // tagged screen items in the drawn state
    // planSharpScreens / planned renderSharpScreens this frame: pixels presented (viewRect, both
    // views) and pixels cleared and drawn (region, per view; multiview counts both layers).
    uint64_t sharpViewPixels = 0, sharpRegionPixels = 0;
    float sharpMs = 0; // CPU time in planSharpScreens and renderSharpScreens
    // Controller-attached items in the drawn state, and how many of them the last render call
    // drew at a valid grip (before frustum culling).
    uint32_t attachedItems = 0, attachedPlaced = 0;
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
    /**
     * A bit per hand (1 left, 2 right) holding an attached object that this frame's
     * setControllerPoses placed: its grip is valid and, for a gripHeld object, squeezed. The object
     * then takes the controller's place in the hand, so the controller model is not drawn there.
     * 0 before setControllerPoses in a frame.
     */
    unsigned attachedHands() const;
    /**
     * The scene-world bounding spheres (x, y, z, radius) of the attached items this frame's
     * setControllerPoses placed, up to `max` of them, finite ones only; returns how many it wrote.
     * The display loop uses them to keep compositor quads from covering what the player holds.
     */
    size_t attachedBounds(float (*out)[4], size_t max) const;
    // render/renderStereo draw into the bound draw framebuffer and viewport, and leave: no program
    // or vertex array bound, GL_ARRAY_BUFFER 0, blend/cull/polygon offset off, depth test on with
    // LEQUAL and writes on, full color mask, front face CCW, active texture unit 0. Texture units
    // 0-4 and uniform buffer bindings 0-2 are left bound to the renderer's objects. With
    // options.clear they clear color (the scene background) and depth first, except for
    // SceneDrawSet::Attached. Several calls after one prepareFrame (the two eyes without
    // multiview, or a World and an Attached pass) draw the same state and add up in stats.
    /** One view (single-view programs). */
    void render(const SceneEye &eye, int viewportHeightPx, SceneDrawSet set = SceneDrawSet::All);
    /**
     * Both eyes. Multiview: one pass into the bound 2-layer framebuffer, bindEye is not called.
     * Otherwise bindEye(0), draw eye 0, bindEye(1), draw eye 1, from the same scene snapshot.
     */
    void renderStereo(const SceneEye eyes[2], int viewportHeightPx,
                      const std::function<void(int eye)> &bindEye = {},
                      SceneDrawSet set = SceneDrawSet::All);

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
