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
    bool statusVisible = false;
    uint64_t revision = 0;
    // These are presentation metadata, never player/server state. The receipt clock is
    // native steady_clock, assigned atomically with the validated snapshot.
    uint32_t presentationEpoch = 0;
    int64_t receivedNs = 0;
    GraphicsControls graphics;
    // Debug builds only (capture_puppet.h); always inactive unless allowPuppet(true) was called.
    PuppetState puppet;
};
/** Parsing happens on the bridge worker. The render thread only copies a small snapshot. */
class BridgeState {
  public:
    bool submit(const std::string &packet, std::string &scene, std::string &error);
    ControlState read();
    void reset();
    /**
     * Debug builds only: read the page's capture puppet from control packets. Release builds
     * (no OFFICE_CAPTURE_PUPPET) ignore the request, and the field is never parsed.
     */
    void allowPuppet(bool allowed);

  private:
    std::mutex mutex;
    ControlState state;
    std::atomic<bool> puppetAllowed{false};
};
} // namespace office
