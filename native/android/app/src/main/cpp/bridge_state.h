#pragma once
#include "capture_puppet.h"
#include "graphics_controls.h"
#include "xr_math.h"
#include <array>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace office {
struct Hover {
    bool valid = false, near = false, holding = false;
    XrVector3f point{};
};
struct Haptic {
    int hand = 0;
    float strength = .3f;
    int ms = 20;
};
struct ControlState {
    bool active = false, panelOpen = true;
    float fade = 0;
    Matrix rig = transform({{0, 0, 0, 1}, {0, 0, 0}});
    std::array<Hover, 2> hands{};
    std::vector<XrVector3f> arc;
    XrVector3f marker{};
    bool teleportValid = false;
    std::vector<Haptic> haptics;
    std::string status = "{\"aim\":\"\",\"message\":\"\"}";
    // statusVisible: either part has text. The counter and toast are composited separately.
    bool statusVisible = false, statusCounter = false, statusMessage = false;
    uint64_t revision = 0;
    // These are presentation metadata, never player/server state. The receipt clock is
    // native steady_clock, assigned atomically with the validated snapshot.
    uint32_t presentationEpoch = 0;
    int64_t receivedNs = 0;
    GraphicsControls graphics;
    // Debug builds only (capture_puppet.h); always inactive unless allowPuppet(true) was called.
    PuppetState puppet;
};
/**
 * The graphics settings the native host keeps between launches, so the first world targets match
 * the stored choice: render scale, foveation and the FPS counter. The diagnostic view and the
 * sharp-screen choice are never stored.
 */
std::string storedGraphics(const GraphicsControls &graphics);
/**
 * False, leaving graphics unchanged, for a missing, corrupted or unsupported copy. Older copies
 * without "fps" restore it as off; older foveation names (clarity, balanced, performance) map to
 * low, medium and high.
 */
bool restoreGraphics(const std::string &text, GraphicsControls &graphics);
/**
 * The host's settings as the page mirrors them (nativeReadEvents "graphics"), version 1:
 * {v, renderScale, foveation: off|low|medium|high, fps, sharpScreens, foveationDebug}.
 */
std::string graphicsEvent(const GraphicsControls &graphics);
/** off, low, medium, high, and the older clarity, balanced, performance. False otherwise. */
bool foveationFromName(const std::string &name, FoveationQuality &quality);
/** What a graphics-owning host accepts: scale in [0.75, 2], no sharp screens or diagnostic. */
GraphicsControls hostGraphics(GraphicsControls graphics);
/** The closed-workspace FPS counter from the pulled metrics (nativeReadMetrics). */
std::string fpsCounterText(const std::string &metrics);
/**
 * What the APK's settings view shows (nativeReadGraphicsStatus): the host's graphics, the
 * renderer's recommended, maximum and applied eye sizes, the size the choice selects, the exact
 * maximum multiplier, the bound foveation, whether new targets are still pending, the target
 * error and the counter text. Unknown values are null until the renderer has reported them.
 */
std::string graphicsStatus(const GraphicsControls &graphics, const std::string &metrics);

/** Parsing happens on the bridge worker. The render thread only copies a small snapshot. */
class BridgeState {
  public:
    bool submit(const std::string &packet, std::string &scene, std::string &error);
    ControlState read();
    /**
     * Clears the page's controls. Graphics stay until the next page sends its own, so a reload
     * does not replace the world targets with defaults and back.
     */
    void reset();
    /**
     * Graphics to use until a page (or, when the host owns them, the host) sets some, such as the
     * last launch's (storedGraphics).
     */
    void seedGraphics(const GraphicsControls &graphics);
    GraphicsControls graphics();
    /**
     * True once after a page or the host changed what storedGraphics keeps; graphics receives the
     * settings.
     */
    bool takeStoredGraphics(GraphicsControls &graphics);
    /**
     * From now on the native host owns graphics: control packets' "graphics" is ignored without
     * being parsed, so a stale or older page can neither overwrite nor reject anything, and the
     * page's FPS counter text is replaced by the host's (setCounter) when graphics.fps is on.
     */
    void ownGraphics();
    bool ownsGraphics();
    /** The host's choice (hostGraphics), applied at once. Ignored unless ownGraphics was called. */
    bool setGraphics(const GraphicsControls &graphics);
    /** The host's FPS counter text, shown in the status counter while graphics.fps is on. */
    void setCounter(const std::string &text);
    /**
     * Debug builds only: read the page's capture puppet from control packets. Release builds
     * (no OFFICE_CAPTURE_PUPPET) ignore the request, and the field is never parsed.
     */
    void allowPuppet(bool allowed);

  private:
    /** Under the lock: target's status from the page's toast and the page's or host's counter. */
    void composeStatus(ControlState &target) const;
    std::mutex mutex;
    ControlState state;
    bool graphicsReceived = false, storedChanged = false, hostOwned = false;
    std::string pageCounter, pageMessage, hostCounter = "Measuring FPS…";
    std::atomic<bool> puppetAllowed{false};
};
} // namespace office
