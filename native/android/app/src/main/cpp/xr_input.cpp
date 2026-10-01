#include "xr_input.h"
#include "xr_util.h"
#include <algorithm>
#include <android/log.h>
#include <cstdio>
#include <cstring>
#include <stdexcept>

namespace office {
namespace {
void check(XrResult result, const char *operation) {
    if (XR_FAILED(result))
        throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
}
template <class T> T function(XrInstance instance, const char *name) {
    PFN_xrVoidFunction out = nullptr;
    check(xrGetInstanceProcAddr(instance, name, &out), name);
    return reinterpret_cast<T>(out);
}
void number(std::string &out, double value) {
    char buffer[48];
    snprintf(buffer, sizeof(buffer), "%.5f", value);
    out += buffer;
}
void poseJson(std::string &out, XrPosef pose) {
    out += '[';
    const float values[]{pose.position.x,    pose.position.y,    pose.position.z,
                         pose.orientation.x, pose.orientation.y, pose.orientation.z,
                         pose.orientation.w};
    for (int i = 0; i < 7; i++) {
        if (i)
            out += ',';
        number(out, values[i]);
    }
    out += ']';
}
} // namespace

XrPath XrInput::path(const std::string &value) {
    XrPath out;
    check(xrStringToPath(instance, value.c_str(), &out), value.c_str());
    return out;
}
XrAction XrInput::action(const char *name, XrActionType type, bool subactions) {
    auto info = office::structure<XrActionCreateInfo>(XR_TYPE_ACTION_CREATE_INFO);
    strncpy(info.actionName, name, XR_MAX_ACTION_NAME_SIZE - 1);
    strncpy(info.localizedActionName, name, XR_MAX_LOCALIZED_ACTION_NAME_SIZE - 1);
    info.actionType = type;
    info.countSubactionPaths = subactions ? 2 : 0;
    info.subactionPaths = subactions ? paths.data() : nullptr;
    XrAction out;
    check(xrCreateAction(actionSet, &info, &out), name);
    return out;
}

XrInput::XrInput(XrInstance i, XrSession s, bool gaze) : instance(i), session(s) {
    paths = {path("/user/hand/left"), path("/user/hand/right")};
    controllerProfiles = {path("/interaction_profiles/oculus/touch_controller"),
                          path("/interaction_profiles/khr/simple_controller")};
    auto set = office::structure<XrActionSetCreateInfo>(XR_TYPE_ACTION_SET_CREATE_INFO);
    strcpy(set.actionSetName, "office");
    strcpy(set.localizedActionSetName, "Droid Office");
    check(xrCreateActionSet(instance, &set, &actionSet), "create action set");
    aim = action("aim", XR_ACTION_TYPE_POSE_INPUT);
    grip = action("grip", XR_ACTION_TYPE_POSE_INPUT);
    trigger = action("select", XR_ACTION_TYPE_FLOAT_INPUT);
    squeeze = action("grab", XR_ACTION_TYPE_FLOAT_INPUT);
    stick = action("stick", XR_ACTION_TYPE_VECTOR2F_INPUT);
    stickClick = action("stick_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
    primary = action("primary_button", XR_ACTION_TYPE_BOOLEAN_INPUT);
    secondary = action("secondary_button", XR_ACTION_TYPE_BOOLEAN_INPUT);
    menu = action("menu", XR_ACTION_TYPE_BOOLEAN_INPUT);
    vibration = action("feedback", XR_ACTION_TYPE_VIBRATION_OUTPUT);
    auto bind = [&](const char *profile, const std::vector<XrActionSuggestedBinding> &bindings) {
        auto info = office::structure<XrInteractionProfileSuggestedBinding>(
            XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING);
        info.interactionProfile = path(profile);
        info.countSuggestedBindings = bindings.size();
        info.suggestedBindings = bindings.data();
        XrResult result = xrSuggestInteractionProfileBindings(instance, &info);
        __android_log_print(ANDROID_LOG_INFO, "OfficeXR", "BIND %s result=%d", profile, result);
        return result;
    };
    std::vector<XrActionSuggestedBinding> touch, simple;
    for (int h = 0; h < 2; h++) {
        std::string root = h ? "/user/hand/right" : "/user/hand/left";
        auto b = [&](XrAction a, const char *suffix) {
            return XrActionSuggestedBinding{a, path(root + suffix)};
        };
        touch.push_back(b(aim, "/input/aim/pose"));
        touch.push_back(b(grip, "/input/grip/pose"));
        touch.push_back(b(trigger, "/input/trigger/value"));
        touch.push_back(b(squeeze, "/input/squeeze/value"));
        touch.push_back(b(stick, "/input/thumbstick"));
        touch.push_back(b(stickClick, "/input/thumbstick/click"));
        touch.push_back(b(primary, h ? "/input/a/click" : "/input/x/click"));
        touch.push_back(b(secondary, h ? "/input/b/click" : "/input/y/click"));
        touch.push_back(b(vibration, "/output/haptic"));
        if (!h)
            touch.push_back(b(menu, "/input/menu/click"));
        simple.push_back(b(aim, "/input/aim/pose"));
        simple.push_back(b(grip, "/input/grip/pose"));
        simple.push_back(b(trigger, "/input/select/click"));
        // The left controller's menu button is the only physical menu action.
        if (!h)
            simple.push_back(b(menu, "/input/menu/click"));
        simple.push_back(b(vibration, "/output/haptic"));
        auto space = office::structure<XrActionSpaceCreateInfo>(XR_TYPE_ACTION_SPACE_CREATE_INFO);
        space.subactionPath = paths[h];
        space.poseInActionSpace.orientation.w = 1;
        space.action = aim;
        check(xrCreateActionSpace(session, &space, &aims[h]), "aim space");
        space.action = grip;
        check(xrCreateActionSpace(session, &space, &grips[h]), "grip space");
    }
    check(bind("/interaction_profiles/oculus/touch_controller", touch),
          "bind Galaxy XR controllers");
    bind("/interaction_profiles/khr/simple_controller", simple);
    if (gaze) {
        gazeAction = action("eye_gaze", XR_ACTION_TYPE_POSE_INPUT, false);
        bind("/interaction_profiles/ext/eye_gaze_interaction",
             {{gazeAction, path("/user/eyes_ext/input/gaze_ext/pose")}});
        auto space = office::structure<XrActionSpaceCreateInfo>(XR_TYPE_ACTION_SPACE_CREATE_INFO);
        space.action = gazeAction;
        space.poseInActionSpace.orientation.w = 1;
        check(xrCreateActionSpace(session, &space, &gazeSpace), "gaze space");
    }
    auto attach =
        office::structure<XrSessionActionSetsAttachInfo>(XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO);
    attach.countActionSets = 1;
    attach.actionSets = &actionSet;
    check(xrAttachSessionActionSets(session, &attach), "attach actions");
}
XrInput::~XrInput() {
    for (auto s : aims)
        if (s)
            xrDestroySpace(s);
    for (auto s : grips)
        if (s)
            xrDestroySpace(s);
    if (gazeSpace)
        xrDestroySpace(gazeSpace);
    if (actionSet)
        xrDestroyActionSet(actionSet);
}
float XrInput::scalar(XrAction a, int hand) {
    auto get = office::structure<XrActionStateGetInfo>(XR_TYPE_ACTION_STATE_GET_INFO);
    get.action = a;
    get.subactionPath = paths[hand];
    auto state = office::structure<XrActionStateFloat>(XR_TYPE_ACTION_STATE_FLOAT);
    return XR_SUCCEEDED(xrGetActionStateFloat(session, &get, &state)) && state.isActive
               ? state.currentState
               : 0;
}
bool XrInput::boolean(XrAction a, int hand) {
    auto get = office::structure<XrActionStateGetInfo>(XR_TYPE_ACTION_STATE_GET_INFO);
    get.action = a;
    get.subactionPath = paths[hand];
    auto state = office::structure<XrActionStateBoolean>(XR_TYPE_ACTION_STATE_BOOLEAN);
    return XR_SUCCEEDED(xrGetActionStateBoolean(session, &get, &state)) && state.isActive &&
           state.currentState;
}
bool XrInput::pose(XrAction a, XrSpace space, XrPath subaction, XrSpace base, XrTime time,
                   XrPosef &result, bool requireTracked) {
    auto get = office::structure<XrActionStateGetInfo>(XR_TYPE_ACTION_STATE_GET_INFO);
    get.action = a;
    get.subactionPath = subaction;
    auto state = office::structure<XrActionStatePose>(XR_TYPE_ACTION_STATE_POSE);
    if (XR_FAILED(xrGetActionStatePose(session, &get, &state)) || !state.isActive)
        return false;
    auto location = office::structure<XrSpaceLocation>(XR_TYPE_SPACE_LOCATION);
    if (XR_FAILED(xrLocateSpace(space, base, time, &location)))
        return false;
    constexpr XrSpaceLocationFlags valid =
        XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
    if ((location.locationFlags & valid) != valid)
        return false;
    if (requireTracked && !(location.locationFlags & XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT))
        return false;
    result = location.pose;
    return true;
}
InputFrame XrInput::sample(XrSpace base, XrTime time, XrPosef head) {
    InputFrame frame;
    frame.time = time / 1e6;
    frame.head = head;
    XrActiveActionSet active{actionSet, XR_NULL_PATH};
    auto sync = office::structure<XrActionsSyncInfo>(XR_TYPE_ACTIONS_SYNC_INFO);
    sync.countActiveActionSets = 1;
    sync.activeActionSets = &active;
    if (xrSyncActions(session, &sync) != XR_SUCCESS)
        return frame;
    for (int h = 0; h < 2; h++) {
        auto &hand = frame.hands[h];
        auto current =
            office::structure<XrInteractionProfileState>(XR_TYPE_INTERACTION_PROFILE_STATE);
        if (XR_SUCCEEDED(xrGetCurrentInteractionProfile(session, paths[h], &current))) {
            if (current.interactionProfile != profiles[h]) {
                profiles[h] = current.interactionProfile;
                char name[XR_MAX_PATH_LENGTH]{};
                uint32_t count = 0;
                if (profiles[h])
                    xrPathToString(instance, profiles[h], sizeof(name), &count, name);
                __android_log_print(ANDROID_LOG_INFO, "OfficeXR", "INPUT_PROFILE %d %s", h, name);
            }
        }
        // Only a bound motion controller drives a slot. Any other source is ignored.
        const bool controller =
            profiles[h] == controllerProfiles[0] || profiles[h] == controllerProfiles[1];
        hand.active = controller && pose(aim, aims[h], paths[h], base, time, hand.aim);
        if (!hand.active)
            continue;
        hand.gripTracked = pose(grip, grips[h], paths[h], base, time, hand.grip, true);
        if (!hand.gripTracked)
            hand.grip = hand.aim;
        hand.trigger = scalar(trigger, h);
        hand.squeeze = scalar(squeeze, h);
        hand.primary = boolean(primary, h);
        hand.secondary = boolean(secondary, h);
        hand.menu = boolean(menu, h);
        hand.stickClick = boolean(stickClick, h);
        auto get = office::structure<XrActionStateGetInfo>(XR_TYPE_ACTION_STATE_GET_INFO);
        get.action = stick;
        get.subactionPath = paths[h];
        auto axes = office::structure<XrActionStateVector2f>(XR_TYPE_ACTION_STATE_VECTOR2F);
        if (XR_SUCCEEDED(xrGetActionStateVector2f(session, &get, &axes)) && axes.isActive)
            hand.stick = axes.currentState;
    }
    return frame;
}
bool XrInput::gazePose(XrSpace base, XrTime time, XrPosef &gaze) {
    return gazeAction && pose(gazeAction, gazeSpace, XR_NULL_PATH, base, time, gaze, true);
}
void XrInput::haptic(int hand, float amplitude, int milliseconds) {
    if (hand < 0 || hand > 1)
        return;
    auto info = office::structure<XrHapticActionInfo>(XR_TYPE_HAPTIC_ACTION_INFO);
    info.action = vibration;
    info.subactionPath = paths[hand];
    auto pulse = office::structure<XrHapticVibration>(XR_TYPE_HAPTIC_VIBRATION);
    pulse.amplitude = amplitude;
    pulse.duration = std::clamp(milliseconds, 1, 1000) * 1'000'000LL;
    pulse.frequency = XR_FREQUENCY_UNSPECIFIED;
    xrApplyHapticFeedback(session, &info, reinterpret_cast<XrHapticBaseHeader *>(&pulse));
}
std::string XrInput::json(const std::vector<InputFrame> &frames) {
    std::string out;
    out.reserve(frames.size() * 700);
    out += '[';
    for (size_t f = 0; f < frames.size(); f++) {
        if (f)
            out += ',';
        const auto &frame = frames[f];
        out += "{\"time\":";
        number(out, frame.time);
        out += ",\"head\":";
        poseJson(out, frame.head);
        out += ",\"headTracked\":";
        out += frame.headTracked ? "true" : "false";
        out += ",\"hands\":[";
        for (int h = 0; h < 2; h++) {
            if (h)
                out += ',';
            const auto &hand = frame.hands[h];
            out += "{\"active\":";
            out += hand.active ? "true" : "false";
            out += ",\"ui\":";
            out += hand.ui ? "true" : "false";
            out += ",\"gripTracked\":";
            out += hand.gripTracked ? "true" : "false";
            out += ",\"aim\":";
            poseJson(out, hand.aim);
            out += ",\"grip\":";
            poseJson(out, hand.grip);
            out += ",\"trigger\":";
            number(out, hand.trigger);
            out += ",\"squeeze\":";
            number(out, hand.squeeze);
            out += ",\"stick\":[";
            number(out, hand.stick.x);
            out += ',';
            number(out, hand.stick.y);
            out += ']';
            out += ",\"a\":";
            out += hand.primary ? "true" : "false";
            out += ",\"b\":";
            out += hand.secondary ? "true" : "false";
            out += ",\"menu\":";
            out += hand.menu ? "true" : "false";
            out += ",\"stickClick\":";
            out += hand.stickClick ? "true" : "false";
            if (hand.puppet)
                out += ",\"puppet\":true";
            out += '}';
        }
        out += "]}";
    }
    out += ']';
    return out;
}
} // namespace office
