#pragma once

namespace office {
/**
 * The left controller's Menu button opens and closes the APK's own settings view. A press counts
 * only as a fresh rising edge on a tracked controller: a button already held when tracking returns
 * or the session regains focus waits for its release, so tracking loss cannot replay a stale press.
 */
class SettingsMenuButton {
  public:
    bool step(bool active, bool pressed) {
        if (!active) {
            armed = false;
            return false;
        }
        const bool press = armed && pressed && !held;
        held = pressed;
        if (!pressed)
            armed = true;
        return press;
    }

  private:
    bool held = false, armed = false;
};

/**
 * Whether the workspace quad is composited. The APK settings view and Android dialogs open it on
 * their own. The "Office workspace" button asks the page to open its workspace and closes the
 * settings at once; the quad stays up (handoff) until the page reports the workspace open, or for
 * at most kHandoffMs, so the panel does not close and re-place itself in between.
 */
class WorkspacePanel {
  public:
    static constexpr double kHandoffMs = 1000;
    bool step(bool pageOpen, bool overlay, bool settings, bool handoff, double nowMs) {
        if (handoff)
            holdUntil = nowMs + kHandoffMs;
        if (pageOpen || nowMs > holdUntil || nowMs < holdUntil - kHandoffMs)
            holdUntil = -1;
        return pageOpen || overlay || settings || holdUntil >= 0;
    }

  private:
    double holdUntil = -1;
};
} // namespace office
