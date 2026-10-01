#pragma once
#include "graphics_controls.h"
#include "xr_math.h"
#include <array>
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
};
/**
 * The graphics settings the native host keeps between launches, so the first world targets match
 * the page's stored choice: render scale and foveation only. The diagnostic view and the
 * sharp-screen choice wait for the page.
 */
std::string storedGraphics(const GraphicsControls &graphics);
/** False, leaving graphics unchanged, for a missing, corrupted or unsupported copy. */
bool restoreGraphics(const std::string &text, GraphicsControls &graphics);

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
    /** Graphics to use until a page sends some, such as the last launch's (storedGraphics). */
    void seedGraphics(const GraphicsControls &graphics);
    GraphicsControls graphics();
    /** True once after a page changed what storedGraphics keeps; graphics receives the settings. */
    bool takeStoredGraphics(GraphicsControls &graphics);

  private:
    std::mutex mutex;
    ControlState state;
    bool graphicsReceived = false, storedChanged = false;
};
} // namespace office
