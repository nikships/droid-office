#pragma once
// Pure logic of the debug-only Vulkan foveation spike (vk_spike.cpp). No Vulkan, OpenXR or
// Android types, so native/tests/vk_spike_logic_test.cpp runs it on the host.
#include "json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace office::spike {

/** World pass sample modes. Godot issue #113778 reports that eye-tracked foveation with MSAA
 *  resolved inside the subpass renders everything at the lowest density on Galaxy XR, so M1
 *  measures each one (design gate G-V6). */
enum class Msaa { Single, Resolve4, RenderToSingle4 };
/** eye: offsets from xrGetFoveationEyeTrackedStateMETA; none: count 0 (the runtime's map is
 *  used as given); sweep: scripted synthetic offsets, labelled in every log. */
enum class Offsets { Eye, None, Sweep };
/** Axis convention of foveationCenter is unspecified (XR_META_foveation_eye_tracked only says
 *  "NDC space in the range of -1 to 1"); None passes it through as Godot does. */
enum class Flip { None, X, Y, XY };
/** live: one profile kept and re-applied each frame; godot: create, update and destroy a profile
 *  every frame (Godot openxr_fb_foveation_extension.cpp _update_profile_rt). */
enum class ProfileMode { Live, PerFrame };

inline const char *name(Msaa value) {
    switch (value) {
    case Msaa::Single:
        return "1";
    case Msaa::Resolve4:
        return "4";
    case Msaa::RenderToSingle4:
        return "4ms";
    }
    return "?";
}
inline const char *name(Offsets value) {
    switch (value) {
    case Offsets::Eye:
        return "eye";
    case Offsets::None:
        return "none";
    case Offsets::Sweep:
        return "sweep";
    }
    return "?";
}
inline const char *name(Flip value) {
    switch (value) {
    case Flip::None:
        return "none";
    case Flip::X:
        return "x";
    case Flip::Y:
        return "y";
    case Flip::XY:
        return "xy";
    }
    return "?";
}
inline const char *name(ProfileMode value) {
    return value == ProfileMode::Live ? "live" : "per-frame";
}
/** Index into XrFoveationLevelFB (NONE 0, LOW 1, MEDIUM 2, HIGH 3; XR_FB_foveation_configuration).
 */
inline const char *levelName(int level) {
    static const char *names[]{"none", "low", "medium", "high"};
    return level >= 0 && level <= 3 ? names[level] : "?";
}

struct Options {
    Msaa msaa = Msaa::Resolve4;
    Offsets offsets = Offsets::Eye;
    int level = 3;
    bool overlay = true;
    /** Profile without XrFoveationEyeTrackedProfileCreateInfoMETA: the static control. */
    bool fixed = false;
    /** false: the world swapchain is created without XrSwapchainCreateInfoFoveationFB. */
    bool foveation = true;
    /** Create (then destroy) a VK_IMAGE_CREATE_SUBSAMPLED_BIT_EXT swapchain once and log it. */
    bool subsampledProbe = false;
    Flip flip = Flip::None;
    ProfileMode profile = ProfileMode::Live;
    bool eyePermission = false;
    std::vector<std::string> warnings;
};

namespace detail {
inline bool flag(const std::string &value, bool &out) {
    if (value == "1" || value == "true" || value == "on") {
        out = true;
        return true;
    }
    if (value == "0" || value == "false" || value == "off") {
        out = false;
        return true;
    }
    return false;
}
} // namespace detail

/** "renderer=vulkan-spike;msaa=4;offsets=eye;..." as OfficeActivity.startNative builds it. */
inline Options parseOptions(const std::string &text) {
    Options out;
    size_t start = 0;
    while (start <= text.size()) {
        size_t end = text.find(';', start);
        if (end == std::string::npos)
            end = text.size();
        const std::string item = text.substr(start, end - start);
        start = end + 1;
        if (item.empty())
            continue;
        const auto equals = item.find('=');
        const std::string key = item.substr(0, equals);
        const std::string value = equals == std::string::npos ? "" : item.substr(equals + 1);
        bool ok = true;
        if (key == "renderer")
            ok = value == "vulkan-spike";
        else if (key == "msaa") {
            if (value == "1")
                out.msaa = Msaa::Single;
            else if (value == "4")
                out.msaa = Msaa::Resolve4;
            else if (value == "4ms")
                out.msaa = Msaa::RenderToSingle4;
            else
                ok = false;
        } else if (key == "offsets") {
            if (value == "eye")
                out.offsets = Offsets::Eye;
            else if (value == "none")
                out.offsets = Offsets::None;
            else if (value == "sweep")
                out.offsets = Offsets::Sweep;
            else
                ok = false;
        } else if (key == "level") {
            ok = false;
            for (int level = 0; level <= 3; ++level)
                if (value == levelName(level)) {
                    out.level = level;
                    ok = true;
                }
        } else if (key == "overlay")
            ok = detail::flag(value, out.overlay);
        else if (key == "fixed")
            ok = detail::flag(value, out.fixed);
        else if (key == "foveation")
            ok = detail::flag(value, out.foveation);
        else if (key == "subsampled_probe")
            ok = detail::flag(value, out.subsampledProbe);
        else if (key == "eye_permission")
            ok = detail::flag(value, out.eyePermission);
        else if (key == "flip") {
            if (value == "none")
                out.flip = Flip::None;
            else if (value == "x")
                out.flip = Flip::X;
            else if (value == "y")
                out.flip = Flip::Y;
            else if (value == "xy")
                out.flip = Flip::XY;
            else
                ok = false;
        } else if (key == "profile") {
            if (value == "live")
                out.profile = ProfileMode::Live;
            else if (value == "per-frame" || value == "godot")
                out.profile = ProfileMode::PerFrame;
            else
                ok = false;
        } else
            ok = false;
        if (!ok)
            out.warnings.push_back(item);
    }
    return out;
}

inline nlohmann::json describe(const Options &options) {
    return {{"msaa", name(options.msaa)},
            {"offsets", name(options.offsets)},
            {"level", levelName(options.level)},
            {"overlay", options.overlay},
            {"fixed", options.fixed},
            {"foveation", options.foveation},
            {"subsampledProbe", options.subsampledProbe},
            {"flip", name(options.flip)},
            {"profile", name(options.profile)},
            {"eyePermission", options.eyePermission},
            {"ignored", options.warnings}};
}

/** Nearest multiple of granularity, symmetric for negative values. Offsets must be integer
 *  multiples of fragmentDensityOffsetGranularity (VkSubpassFragmentDensityMapOffsetEndInfoQCOM
 *  valid usage). Godot rounds with ((o + g/2) / g) * g (openxr_vulkan_extension.cpp:224), which
 *  is the same for positive offsets. */
inline int roundToGranularity(float value, int granularity) {
    const int g = std::max(granularity, 1);
    if (!std::isfinite(value))
        return 0;
    return static_cast<int>(std::lround(value / g)) * g;
}

struct Offset {
    int x = 0, y = 0;
    bool operator==(const Offset &other) const { return x == other.x && y == other.y; }
};

/** A foveation centre (NDC, -1..1) to framebuffer pixels: centre * (image size / 2), as Godot's
 *  get_fragment_density_offsets (openxr_fb_foveation_extension.cpp:237-242), then rounded to the
 *  granularity. Each (x,y) offset "is in framebuffer pixels and shifts the fetch of the fragment
 *  density map by that amount" (VkRenderPassFragmentDensityMapOffsetEndInfoEXT). */
inline Offset centreOffset(float cx, float cy, Flip flip, int width, int height, int granularityX,
                           int granularityY) {
    cx = std::isfinite(cx) ? std::clamp(cx, -1.f, 1.f) : 0.f;
    cy = std::isfinite(cy) ? std::clamp(cy, -1.f, 1.f) : 0.f;
    if (flip == Flip::X || flip == Flip::XY)
        cx = -cx;
    if (flip == Flip::Y || flip == Flip::XY)
        cy = -cy;
    return {roundToGranularity(cx * width * .5f, granularityX),
            roundToGranularity(cy * height * .5f, granularityY)};
}

/** Where a density-map offset puts the map's centre in framebuffer pixels (top-left origin):
 *  "applying a positive offset in the x component will shift the fragment density map to the
 *  right relative to the framebuffer" (Vulkan spec, Fetch Density Value). */
inline std::array<float, 2> markerPixel(Offset offset, int width, int height) {
    return {width * .5f + offset.x, height * .5f + offset.y};
}

/** Diagnostic only, never used to place the fovea: a view-space gaze direction (OpenXR view
 *  axes, -z forward, +y up) as NDC of a view with these FOV tangents (+y up). Logged next to the
 *  runtime's foveationCenter so its axis convention can be read off the log. */
inline std::array<float, 2> gazeNdc(float x, float y, float z, float left, float right, float down,
                                    float up) {
    if (!(z < -1e-4f) || !(right > left) || !(up > down))
        return {0, 0};
    const float tx = x / -z, ty = y / -z;
    return {2 * (tx - left) / (right - left) - 1, 2 * (ty - down) / (up - down) - 1};
}

/** Synthetic offset sweep (design gate G-V5): the centre, then right, down, left and up at half
 *  of each image half-extent, each held for holdSeconds. Values are NDC-like fractions. */
struct SweepPoint {
    int index = 0;
    float x = 0, y = 0;
};
inline SweepPoint sweepPoint(double seconds, double holdSeconds = 3) {
    static const float points[5][2]{{0, 0}, {.5f, 0}, {0, .5f}, {-.5f, 0}, {0, -.5f}};
    if (!(seconds >= 0) || !(holdSeconds > 0))
        return {};
    const int index = static_cast<int>(std::fmod(seconds / holdSeconds, 5.));
    const int i = std::clamp(index, 0, 4);
    return {i, points[i][0], points[i][1]};
}

/** Rate limit for per-frame FOVEATION_VK lines: every frame for the first `burst` frames after a
 *  mode change, on any change of the result signature, otherwise once per `period` seconds. */
class LogGate {
  public:
    explicit LogGate(int burst = 5, double period = 1)
        : burst(burst), period(period), remaining(burst) {}
    void restart() {
        remaining = burst;
        hasSignature = false;
    }
    bool shouldLog(double now, int64_t signature) {
        bool log = false;
        if (remaining > 0) {
            --remaining;
            log = true;
        }
        if (!hasSignature || signature != lastSignature)
            log = true;
        if (!(now - lastLog < period))
            log = true;
        hasSignature = true;
        lastSignature = signature;
        if (log)
            lastLog = now;
        return log;
    }

  private:
    int burst;
    double period;
    int remaining;
    bool hasSignature = false;
    int64_t lastSignature = 0;
    double lastLog = -1e9;
};

/** One frame's foveation outcome, as vk_spike.cpp records it. Results are XrResult values. */
struct FoveationFrame {
    bool updated = false, queried = false;
    int updateResult = 0, stateResult = 0;
    uint64_t flags = 0;
    bool valid = false;
    std::array<std::array<float, 2>, 2> centres{};
    bool applied = false;
    std::array<Offset, 2> offsets{};
};

/** Per FRAME_METRICS window (5 s) summary of the per-frame foveation calls. */
class FoveationWindow {
  public:
    void add(const FoveationFrame &frame) {
        ++frames;
        if (frame.updated) {
            ++updates;
            if (frame.updateResult < 0)
                ++updateFailures;
            lastUpdate = frame.updateResult;
        }
        if (frame.queried) {
            ++queries;
            if (frame.stateResult >= 0)
                ++querySuccess;
            if (frame.valid)
                ++valid;
            lastState = frame.stateResult;
            lastFlags = frame.flags;
            if (frame.valid) {
                lastCentres = frame.centres;
                for (int eye = 0; eye < 2; ++eye)
                    for (int axis = 0; axis < 2; ++axis) {
                        const float c = frame.centres[eye][axis];
                        minimum[eye][axis] = std::min(minimum[eye][axis], c);
                        maximum[eye][axis] = std::max(maximum[eye][axis], c);
                    }
            }
        }
        if (frame.applied) {
            ++applied;
            lastOffsets = frame.offsets;
        }
    }
    nlohmann::json json() const {
        auto pairs = [](const std::array<std::array<float, 2>, 2> &v) {
            return nlohmann::json::array({{v[0][0], v[0][1]}, {v[1][0], v[1][1]}});
        };
        nlohmann::json out{{"frames", frames},
                           {"updates", updates},
                           {"updateFailures", updateFailures},
                           {"queries", queries},
                           {"querySuccess", querySuccess},
                           {"valid", valid},
                           {"applied", applied},
                           {"lastUpdate", lastUpdate},
                           {"lastState", lastState},
                           {"lastFlags", lastFlags}};
        out["centres"] = valid ? pairs(lastCentres) : nlohmann::json(nullptr);
        // How far each eye's centre moved inside the window: [eye][axis] = max - min.
        if (valid) {
            std::array<std::array<float, 2>, 2> spread{};
            for (int eye = 0; eye < 2; ++eye)
                for (int axis = 0; axis < 2; ++axis)
                    spread[eye][axis] = maximum[eye][axis] - minimum[eye][axis];
            out["centreSpread"] = pairs(spread);
        } else
            out["centreSpread"] = nullptr;
        out["offsets"] = applied ? nlohmann::json::array({{lastOffsets[0].x, lastOffsets[0].y},
                                                          {lastOffsets[1].x, lastOffsets[1].y}})
                                 : nlohmann::json(nullptr);
        return out;
    }

  private:
    uint64_t frames = 0, updates = 0, updateFailures = 0, queries = 0, querySuccess = 0, valid = 0,
             applied = 0;
    int lastUpdate = 0, lastState = 0;
    uint64_t lastFlags = 0;
    std::array<std::array<float, 2>, 2> lastCentres{};
    std::array<std::array<float, 2>, 2> minimum{{{1e9f, 1e9f}, {1e9f, 1e9f}}};
    std::array<std::array<float, 2>, 2> maximum{{{-1e9f, -1e9f}, {-1e9f, -1e9f}}};
    std::array<Offset, 2> lastOffsets{};
};

/** Which parts of the eye-tracked path the spike may use, and why not (logged as is). */
struct EyeGates {
    bool metaExtension = false;   // XR_META_foveation_eye_tracked + _vulkan_swapchain_create_info
    bool systemSupports = false;  // supportsFoveationEyeTracked
    bool permission = false;      // EYE_TRACKING_FINE granted
    bool gazeInteraction = false; // XR_EXT_eye_gaze_interaction enabled and supported
    bool offsetFeature = false;   // fragmentDensityMapOffset enabled on the VkDevice
    bool swapchainOffset = false; // world swapchain created with the OFFSET create flag
    bool densityMap = false;      // runtime returned density images
    bool fixedRequested = false;  // vk_fixed control
    /** XrFoveationEyeTrackedProfileCreateInfoMETA goes in the profile (Godot
     *  openxr_fb_foveation_extension.cpp:275: META extension + system support). */
    bool eyeProfile() const {
        return densityMap && metaExtension && systemSupports && permission && !fixedRequested;
    }
    /** xrUpdateSwapchainFB + xrGetFoveationEyeTrackedStateMETA every frame (Godot :213 also
     *  requires the eye gaze interaction to be available). */
    bool query() const { return eyeProfile() && gazeInteraction; }
    /** Offsets at vkCmdEndRenderPass2 need the feature and the OFFSET flag on every attachment. */
    bool offsets() const { return densityMap && offsetFeature && swapchainOffset; }
    std::string blockers() const {
        std::string out;
        auto add = [&](bool ok, const char *what) {
            if (!ok)
                out += (out.empty() ? "" : ",") + std::string(what);
        };
        add(densityMap, "densityMap");
        add(metaExtension, "metaExtension");
        add(systemSupports, "systemSupports");
        add(permission, "permission");
        add(gazeInteraction, "gazeInteraction");
        add(offsetFeature, "offsetFeature");
        add(swapchainOffset, "swapchainOffset");
        add(!fixedRequested, "fixedRequested");
        return out;
    }
};

/** Status card text (NativeStatusPanel: an aim line and two message lines). */
inline nlohmann::json statusPacket(const Options &options, const EyeGates &gates,
                                   const FoveationFrame &last, double fps) {
    char aim[160], message[240];
    snprintf(aim, sizeof(aim), "Vulkan spike  level %s  %s  offsets %s%s  MSAA %s  flip %s",
             levelName(options.level), gates.eyeProfile() ? "eye-tracked" : "fixed",
             name(options.offsets), options.offsets == Offsets::Sweep ? " (synthetic)" : "",
             name(options.msaa), name(options.flip));
    if (last.queried)
        snprintf(message, sizeof(message),
                 "state %d %s  L %.2f %.2f  R %.2f %.2f  offset %d %d / %d %d  %.0f fps",
                 last.stateResult, last.valid ? "VALID" : "invalid", last.centres[0][0],
                 last.centres[0][1], last.centres[1][0], last.centres[1][1], last.offsets[0].x,
                 last.offsets[0].y, last.offsets[1].x, last.offsets[1].y, fps);
    else
        snprintf(message, sizeof(message), "no eye-tracked query (%s)  %.0f fps",
                 gates.blockers().empty() ? "fixed" : gates.blockers().c_str(), fps);
    return {{"aim", aim}, {"message", message}};
}

/** Test room vertex: position (m), normal, material (0 floor, 1 wall, 2 ceiling, 3-5 cubes). */
struct RoomVertex {
    float position[3];
    float normal[3];
    float material;
};
static_assert(sizeof(RoomVertex) == 28, "RoomVertex is the room.vert input layout");

struct RoomMesh {
    std::vector<RoomVertex> vertices;
    std::vector<uint16_t> indices;
};

/** Room extents: x -4..4, z -5..3 (front wall 5 m ahead of the start, rings on it), floor at
 *  floorY, 3.2 m high. Cubes at 1, 2 and 4 m ahead give known depths. Faces wind
 *  counter-clockwise seen from the side their normal points to. */
struct RoomLayout {
    static constexpr float halfWidth = 4, front = -5, back = 3, height = 3.2f;
    static constexpr float cubeDepths[3]{1, 2, 4};
};

inline RoomMesh buildRoom(float floorY) {
    RoomMesh mesh;
    auto quad = [&](std::array<float, 3> a, std::array<float, 3> b, std::array<float, 3> c,
                    std::array<float, 3> d, std::array<float, 3> n, float material) {
        const auto base = static_cast<uint16_t>(mesh.vertices.size());
        for (const auto &p : {a, b, c, d})
            mesh.vertices.push_back({{p[0], p[1], p[2]}, {n[0], n[1], n[2]}, material});
        for (uint16_t i : {0, 1, 2, 0, 2, 3})
            mesh.indices.push_back(static_cast<uint16_t>(base + i));
    };
    const float x0 = -RoomLayout::halfWidth, x1 = RoomLayout::halfWidth;
    const float z0 = RoomLayout::front, z1 = RoomLayout::back;
    const float y0 = floorY, y1 = floorY + RoomLayout::height;
    // Inward-facing room: floor (+y), ceiling (-y), front (+z), back (-z), left (+x), right (-x).
    quad({x0, y0, z1}, {x1, y0, z1}, {x1, y0, z0}, {x0, y0, z0}, {0, 1, 0}, 0);
    quad({x0, y1, z0}, {x1, y1, z0}, {x1, y1, z1}, {x0, y1, z1}, {0, -1, 0}, 2);
    quad({x0, y0, z0}, {x1, y0, z0}, {x1, y1, z0}, {x0, y1, z0}, {0, 0, 1}, 1);
    quad({x1, y0, z1}, {x0, y0, z1}, {x0, y1, z1}, {x1, y1, z1}, {0, 0, -1}, 1);
    quad({x0, y0, z1}, {x0, y0, z0}, {x0, y1, z0}, {x0, y1, z1}, {1, 0, 0}, 1);
    quad({x1, y0, z0}, {x1, y0, z1}, {x1, y1, z1}, {x1, y1, z0}, {-1, 0, 0}, 1);
    // Outward-facing cubes (0.3 m) at known depths, left, centre and right of the view axis.
    const float xs[3]{-.55f, .45f, -.3f}, ys[3]{1.25f, 1.05f, 1.6f};
    for (int i = 0; i < 3; ++i) {
        const float s = .15f, cx = xs[i], cy = floorY + ys[i], cz = -RoomLayout::cubeDepths[i];
        const float a = cx - s, b = cx + s, lo = cy - s, hi = cy + s, n = cz + s, f = cz - s;
        const float m = 3.f + i;
        quad({a, lo, n}, {b, lo, n}, {b, hi, n}, {a, hi, n}, {0, 0, 1}, m);
        quad({b, lo, f}, {a, lo, f}, {a, hi, f}, {b, hi, f}, {0, 0, -1}, m);
        quad({a, lo, f}, {a, lo, n}, {a, hi, n}, {a, hi, f}, {-1, 0, 0}, m);
        quad({b, lo, n}, {b, lo, f}, {b, hi, f}, {b, hi, n}, {1, 0, 0}, m);
        quad({a, hi, n}, {b, hi, n}, {b, hi, f}, {a, hi, f}, {0, 1, 0}, m);
        quad({a, lo, f}, {b, lo, f}, {b, lo, n}, {a, lo, n}, {0, -1, 0}, m);
    }
    return mesh;
}

} // namespace office::spike
