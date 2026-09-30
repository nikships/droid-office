#pragma once
#include "xr_math.h"
#include <array>
#include <openxr/openxr.h>
#include <string>
#include <vector>

namespace office {
/** One motion controller slot. Tracked hands are not an input source for the native client. */
struct HandInput {
    bool active = false, primary = false, secondary = false, menu = false, stickClick = false,
         ui = false;
    float trigger = 0, squeeze = 0;
    XrVector2f stick{};
    XrPosef aim{{0, 0, 0, 1}, {0, 0, 0}}, grip{{0, 0, 0, 1}, {0, 0, 0}};
};
struct InputFrame {
    double time = 0;
    bool headTracked = false;
    XrPosef head{{0, 0, 0, 1}, {0, 0, 0}};
    std::array<HandInput, 2> hands;
};

class XrInput {
  public:
    XrInput(XrInstance instance, XrSession session, bool gaze);
    ~XrInput();
    InputFrame sample(XrSpace base, XrTime time, XrPosef head);
    bool gazePose(XrSpace base, XrTime time, XrPosef &gaze);
    void haptic(int hand, float amplitude = 0.3f, int milliseconds = 20);
    static std::string json(const std::vector<InputFrame> &frames);

  private:
    XrInstance instance;
    XrSession session;
    XrActionSet actionSet = XR_NULL_HANDLE;
    XrAction aim = XR_NULL_HANDLE, grip = XR_NULL_HANDLE, trigger = XR_NULL_HANDLE,
             squeeze = XR_NULL_HANDLE;
    XrAction stick = XR_NULL_HANDLE, stickClick = XR_NULL_HANDLE, primary = XR_NULL_HANDLE,
             secondary = XR_NULL_HANDLE, menu = XR_NULL_HANDLE, vibration = XR_NULL_HANDLE,
             gazeAction = XR_NULL_HANDLE;
    XrSpace gazeSpace = XR_NULL_HANDLE;
    std::array<XrPath, 2> paths{};
    std::array<XrSpace, 2> aims{}, grips{};
    std::array<XrPath, 2> profiles{};
    std::array<XrPath, 2> controllerProfiles{};
    XrPath path(const std::string &value);
    XrAction action(const char *name, XrActionType type, bool subactions = true);
    float scalar(XrAction action, int hand);
    bool boolean(XrAction action, int hand);
    bool pose(XrAction action, XrSpace space, XrPath subaction, XrSpace base, XrTime time,
              XrPosef &result, bool requireTracked = false);
};
} // namespace office
