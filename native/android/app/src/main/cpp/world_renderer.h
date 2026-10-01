// The frame loop's one seam to a graphics API (vulkan-port.md, option b: a coarse world renderer,
// no draw-call abstraction). office_xr.cpp keeps the API-neutral session: the instance, system,
// session, spaces, Android Surface layers, input, refresh preference, layer composition and the
// metrics lines. A WorldRenderer owns what a graphics API draws: its device, the world and
// sharp-screen targets with their foveation, the scene, controllers, rays, fade and the cursor
// image. world_vk.cpp is the installed Vulkan office; GLES stays a host reference only.
// Render thread only, except the scene calls, which come from bridge threads.
#pragma once

#include "bridge_state.h"
#include "graphics_controls.h"
#include "json.hpp"
#include "scene_frame.h"
#include "xr_input.h"

#include <array>
#include <functional>
#include <jni.h>
#include <openxr/openxr.h>
#include <string>
#include <vector>

namespace office {

/** What the session gives its renderer. */
struct WorldHost {
    JNIEnv *env = nullptr; // the render thread's
    jobject activity = nullptr;
    /** The page's stored graphics settings, seeded into the bridge, for the first targets. */
    std::function<GraphicsControls()> startGraphics;
    /** Edits the metrics the page pulls (latestMetrics) under their lock. */
    std::function<void(const std::function<void(nlohmann::json &)> &)> editMetrics;
};

/** One display frame, as the session located it. */
struct WorldFrame {
    const std::array<XrView, 2> *views = nullptr; // xrLocateViews, the session's space
    const InputFrame *input = nullptr;
    const ControlState *controls = nullptr; // panelOpen includes the native overlay
    XrPosef panelPose{};
    bool focused = false, poseValid = false, shouldRender = false;
    bool valid = false; // shouldRender && poseValid: the world layer is submitted
    // valid && controls->panelOpen: the workspace panel is composited beneath the world layer,
    // so the world image shows it through a hole (panel_cutout.h) with the hands in front.
    bool panelUnder = false;
};

class WorldRenderer {
  public:
    virtual ~WorldRenderer() = default;

    // ---- Bring-up, in this order --------------------------------------------------------------
    /** The OpenXR graphics API extension (XR_KHR_opengl_es_enable, XR_KHR_vulkan_enable2). */
    virtual const char *graphicsExtension() const = 0;
    /**
     * Adds the further instance extensions it uses when `supported` (foveation). eyeGaze:
     * XR_EXT_eye_gaze_interaction is enabled.
     */
    virtual void instanceExtensions(const std::function<bool(const char *)> &supported,
                                    bool eyeGaze, std::vector<const char *> &extensions) = 0;
    /** Chains its structs in front of `next` for xrGetSystemProperties; returns the new head. */
    virtual void *systemProperties(void *next) = 0;
    /**
     * After xrGetSystemProperties: function pointers, graphics requirements and the device.
     * gazeSystem: the system supports eye gaze interaction. Returns XrSessionCreateInfo::next.
     */
    virtual const void *createDevice(XrInstance instance, XrSystemId system,
                                     const XrSystemProperties &properties, bool gazeSystem) = 0;
    /** After xrCreateSession and the Surface layers: targets, scene, controllers and cursor. */
    virtual void createTargets(XrSession session, const std::vector<XrViewConfigurationView> &views,
                               const XrSystemProperties &properties) = 0;

    // ---- Bridge threads -------------------------------------------------------------------------
    virtual void enqueueScene(const std::string &packet) = 0;
    /** False under backpressure. */
    virtual bool acceptsScene() = 0;
    /** True once after a rejected packet: the next pull asks for a reset. */
    virtual bool takeSceneReset() = 0;

    // ---- Frame loop -----------------------------------------------------------------------------
    /** xrBeginSession succeeded. */
    virtual void sessionBegun() = 0;
    /**
     * After this frame's bridge read: replaces the world targets once a changed setting settles,
     * only when mayReplace (focused, located and shouldRender) and with no image acquired.
     */
    virtual void updateTargets(const GraphicsControls &graphics, double nowMs, bool mayReplace) = 0;
    /**
     * Draws the frame (only when frame.valid) and fills the world layer's views and, when it
     * returns true, the sharp-screen layer's. Every image is released before it returns.
     */
    virtual bool render(const WorldFrame &frame,
                        std::array<XrCompositionLayerProjectionView, 2> &world,
                        std::array<XrCompositionLayerProjectionView, 2> &sharp) = 0;
    /** The panel cursor's quad layer at `pose`. */
    virtual XrCompositionLayerQuad cursorLayer(XrSpace space, XrPosef pose) const = 0;
    /**
     * After a valid render: a bit per hand (1 left, 2 right) holding an attached object this frame
     * (SceneRenderer::attachedHands), and the scene-world bounding spheres of those objects
     * (SceneRenderer::attachedBounds), for the status card's cover test.
     */
    virtual unsigned attachedHands() const = 0;
    virtual size_t attachedBounds(float (*out)[4], size_t max) const = 0;

    // ---- A metrics window (every 5 s) -----------------------------------------------------------
    /** Its FRAME_METRICS keys: the world size and limits, the bound foveation, the screen layer. */
    virtual void addFrameMetrics(nlohmann::json &metrics) = 0;
    /** The FOVEATION_METRICS object for this window; starts the next window's samples. */
    virtual nlohmann::json foveationMetrics(const GraphicsControls &graphics) = 0;
    virtual SceneStats sceneStats() const = 0;
    /** Appended to the FRAME_METRICS log line (GLES: " gl_error=<hex>"). */
    virtual std::string frameMetricsSuffix() = 0;

    // ---- Teardown, in this order, after the Surface producers stopped ---------------------------
    /** Completes GPU image use and releases the renderer's helpers. */
    virtual void finishGpuWork() = 0;
    /** The foveation profile, a child of the session. */
    virtual void destroyProfile() = 0;
    /** The world and sharp-screen swapchains and their framebuffers. The device goes with the
     * renderer, after the session and instance. */
    virtual void destroyTargets() = 0;
};

} // namespace office
