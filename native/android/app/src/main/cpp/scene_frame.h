// What every native world renderer plans the same way for a frame, without a graphics API: the
// eyes and controller grips it draws with, frustum culling and three's draw order, the controller
// attached items, the laptop-screen layer's plan, the prepare budget and the frame's statistics.
// A renderer answers what is on its GPU through SceneResidency. GL- and Vulkan-free, so every
// backend and the host tests share it. See scene_renderer.h and docs/vr-native-android.md.
#pragma once

#include "scene_model.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

namespace office {

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

// ---- Planning (the code SceneRenderer's GLES Impl used, shared by every backend) ---------------

/** A pixel rectangle [x0, x1) x [y0, y1) in GL window pixels (bottom-left origin). */
struct PixelRect {
    int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    bool empty() const { return x0 >= x1 || y0 >= y1; }
};

inline PixelRect unite(const PixelRect &a, const PixelRect &b) {
    if (a.empty())
        return b;
    if (b.empty())
        return a;
    return {std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}

inline PixelRect intersect(const PixelRect &a, const PixelRect &b) {
    return {std::max(a.x0, b.x0), std::max(a.y0, b.y0), std::min(a.x1, b.x1), std::min(a.y1, b.y1)};
}

/** A backend's linked program or pipeline for one ProgramKey; each backend derives its own. */
struct ScenePipeline {};

/** What the planner asks a backend about its GPU copies. Render thread only. */
class SceneResidency {
  public:
    /**
     * For a draw this frame: the pipeline for `key` if it can draw now, else null. A missing one
     * may be requested for a later prepare; a draw never starts a build.
     */
    virtual const ScenePipeline *drawPipeline(const scene::ProgramKey &key) = 0;
    /** A pipeline for `key` ready now, else null. Never requests, starts or advances a build. */
    virtual const ScenePipeline *readyPipeline(const scene::ProgramKey &key) const = 0;
    /** Texture `id` is on the GPU and complete. */
    virtual bool textureResident(uint32_t id) const = 0;
    /**
     * The box of vertex buffer `serial`'s positions, gathered while uploading: false unless the
     * buffer is completely uploaded, not empty and every position finite.
     */
    virtual bool vertexBox(uint64_t serial, float lo[3], float hi[3]) const = 0;

  protected:
    ~SceneResidency() = default;
};

/** The SceneRendererOptions the planner follows. */
struct ScenePlanOptions {
    bool multiview = false;
    float sharpMaxDistance = 6.0f;
    int sharpMaxScreens = 16;
    int sharpMaxOverlays = 64;
    bool sharpCropToScreens = true;
};

/** One draw of a frame list. */
struct SceneDraw {
    const scene::DrawItem *item;
    const ScenePipeline *program;
    float z;
    uint8_t views = 3; // the screen layer: bit i set when view i sees the item
};

/**
 * One prepare's budgeted work: upload bytes and program starts left, and the CPU deadline. The
 * first piece of work always runs, so everything arrives.
 */
struct FrameBudget {
    using Clock = std::chrono::steady_clock;
    size_t bytes = 0; // upload bytes left
    int links = 0;    // program (pipeline) builds left to start
    Clock::time_point deadline;
    bool worked = false; // some budgeted work ran this frame (the first piece always may)

    void start(Clock::time_point t0, size_t uploadBytes, int linkCount, float budgetMs) {
        bytes = uploadBytes;
        links = linkCount;
        worked = false;
        deadline = t0 + std::chrono::microseconds(int64_t(double(budgetMs) * 1000.0));
    }
    /** Whether budgeted work may start now: always the first piece of a frame, then within the
     * time budget. */
    bool mayWork() const { return !worked || Clock::now() < deadline; }
};

/** A view of the screen layer: its frustum, view-projection and eye position. */
struct SharpView {
    scene::Frustum frustum;
    scene::Mat4 viewProj;
    scene::Vec3 eye;
};

SharpView sharpView(const SceneEye &e);

/**
 * The screen layer's variants of a color-pass key: multiview draws one pass that samples the
 * depth array by view; single view samples a 2D depth or one layer of an array.
 */
template <typename F> void sharpKeyVariants(bool multiview, scene::ProgramKey key, F &&f) {
    if (multiview) {
        key.multiview = true;
        key.sharpDepth = scene::SharpDepth::Array;
        f(key);
        return;
    }
    key.multiview = false;
    key.sharpDepth = scene::SharpDepth::Texture2D;
    f(key);
    key.sharpDepth = scene::SharpDepth::Array;
    f(key);
}

/**
 * The frame lists of one renderer, rebuilt from the drawn RenderState: the world's opaque and
 * transparent draws, the controller-attached copies placed at this frame's grips, and the screen
 * layer's screens and overlays with their plan. Render thread only.
 */
class SceneFramePlanner {
  public:
    explicit SceneFramePlanner(const ScenePlanOptions &options) : options(options) {}

    // ---- Controller attachments
    /** Grips are valid for one display frame only. */
    void beginFrame();
    /** This frame's grips; recomposes the attached copies of `drawn` (may be null). */
    void setControllerPoses(const SceneControllerPoses &poses, const scene::RenderState *drawn);
    /** Copies the drawn state's attached items once per state, then recomposes them per frame. */
    void syncAttachments(const scene::RenderState &s);

    // ---- The world pass
    /**
     * Culls against every eye and sorts as three's render lists do (painterSortStable and
     * reversePainterSortStable): opaque by group order, render order, material, near to far, id;
     * transparent by group order, render order, far to near, id. Depth is the bounding-sphere
     * center in eye 0's clip space, as three projects the bounding-sphere center.
     */
    void buildLists(const scene::RenderState &s, const SceneEye *eyes, int count,
                    bool multiviewPass, SceneResidency &residency);
    const std::vector<SceneDraw> &opaque() const { return opaque_; }
    const std::vector<SceneDraw> &transparent() const { return transparent_; }
    /** Of the last buildLists: items culled, and attached items placed at a valid grip. */
    uint32_t culledItems() const { return culledItems_; }
    uint32_t attachedPlaced() const { return attachedPlaced_; }

    // ---- The screen layer
    /** A tagged screen in `s` has its texture resident and a program ready. */
    bool hasSharpAnywhere(const scene::RenderState &s, const SceneResidency &residency) const;
    /** As above, for a screen near and inside either eye, for this depth texture kind. */
    bool hasSharp(const scene::RenderState &s, const SceneEye *eyes, bool arrayDepth,
                  const SceneResidency &residency) const;
    /**
     * Fills sharpScreens (the nearest sharpMaxScreens, drawn far to near) and sharpOverlays (the
     * see-through surfaces in front of them, in three's transparent order) for `count` views, view
     * i a w[i] x h[i] image, and cover[i]: every pixel of view i a selected screen may cover. False
     * when no screen qualifies.
     */
    bool selectSharp(const scene::RenderState &s, const SharpView *views, int count,
                     scene::SharpDepth kind, bool multiviewKey, const int w[2], const int h[2],
                     PixelRect cover[2], const SceneResidency &residency);
    /**
     * Plans this frame's screen layer (SceneRenderer::planSharpScreens) for the drawn state
     * `current`; `usable` is false when the renderer cannot draw it. `frame` identifies the
     * display frame for planIsCurrent.
     */
    bool planSharp(const std::shared_ptr<const scene::RenderState> &current, bool usable,
                   uint64_t frame, const SceneEye *eyes, const int *w, const int *h,
                   bool arrayDepth, SharpScreenPlan &plan, const SceneResidency &residency);
    /** `plan` is the latest planSharp, of display frame `frame` and drawn state `current`. */
    bool planIsCurrent(const SharpScreenPlan &plan, uint64_t frame,
                       const std::shared_ptr<const scene::RenderState> &current) const;
    /** The screen lists are about to be replaced outside a plan (the whole-image layer). */
    void forgetPlan() { sharpPlanState_.reset(); }
    const std::vector<SceneDraw> &sharpScreens() const { return sharpScreens_; }
    const std::vector<SceneDraw> &sharpOverlays() const { return sharpOverlays_; }

  private:
    void compose(const scene::RenderState &s);
    void sharpIndex(const scene::RenderState &s) const;
    bool sharpCandidates(const scene::RenderState &s, const SharpView *views, int count,
                         scene::SharpDepth kind, bool multiviewKey, std::vector<SceneDraw> *out,
                         const SceneResidency &residency) const;
    PixelRect itemRect(const scene::DrawItem &it, const scene::Mat4 &vp, int w, int h,
                       const SceneResidency &residency) const;

    ScenePlanOptions options;
    std::vector<SceneDraw> opaque_, transparent_;
    std::vector<SceneDraw> sharpScreens_, sharpOverlays_; // z: eye distance
    uint32_t culledItems_ = 0, attachedPlaced_ = 0;
    // The drawn state's tagged screens and overlay candidates, rebuilt when the state changes.
    mutable uint64_t sharpIndexSerial_ = 0;
    mutable std::vector<const scene::DrawItem *> taggedScreens_, taggedOverlays_;
    // The lists of the latest planSharp, valid for that frame and state only.
    uint64_t sharpPlanToken_ = 0, sharpPlanFrame_ = 0;
    std::shared_ptr<const scene::RenderState> sharpPlanState_;
    // Controller-attached items of the drawn state, in item order: copies whose matrices and
    // sphere are recomposed from the grips each frame (the copies are made once per state).
    std::vector<scene::DrawItem> placed_;
    uint64_t placedSerial_ = 0;
    SceneControllerPoses grips_; // valid[h] only between setControllerPoses and the next frame
};

} // namespace office
