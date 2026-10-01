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
/** Parsing happens on the bridge worker. The render thread only copies a small snapshot. */
class BridgeState {
  public:
    bool submit(const std::string &packet, std::string &scene, std::string &error);
    ControlState read();
    void reset();

  private:
    std::mutex mutex;
    ControlState state;
};
} // namespace office
