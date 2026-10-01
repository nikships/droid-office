#include "bridge_state.h"
#include "foveation.h"
#include "json.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace office {
bool foveationFromName(const std::string &name, FoveationQuality &quality) {
    if (name == "low" || name == "clarity")
        quality = FoveationQuality::Clarity;
    else if (name == "high" || name == "performance")
        quality = FoveationQuality::Performance;
    else if (name == "off")
        quality = FoveationQuality::Off;
    else if (name == "medium" || name == "balanced")
        quality = FoveationQuality::Balanced;
    else
        return false;
    return true;
}
namespace {
using Json = nlohmann::json;
float finite(const Json &value, float limit = 10000) {
    if (!value.is_number())
        throw std::runtime_error("Expected a number");
    double result = value.get<double>();
    if (!std::isfinite(result) || std::abs(result) > limit)
        throw std::runtime_error("Number outside scene limits");
    return static_cast<float>(result);
}
XrVector3f vector(const Json &value) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error("Expected a position");
    return {finite(value[0]), finite(value[1]), finite(value[2])};
}
/** The graphics object of a control packet, version 1. Throws on an invalid value. */
GraphicsControls parseGraphics(const Json &graphics) {
    if (!graphics.is_object() || graphics.value("v", 0) != 1)
        throw std::runtime_error("Unsupported graphics version");
    GraphicsControls result;
    result.sharpScreens = graphics.value("sharpScreens", true);
    result.renderScale = std::clamp(finite(graphics.at("renderScale")), .75f, 2.f);
    // Older pages also send peripheralDensity. Runtime foveation profiles have no density
    // parameter, so it is accepted and ignored.
    result.foveationDebug = graphics.value("foveationDebug", false);
    result.fps = graphics.value("fps", false);
    if (!foveationFromName(graphics.value("foveation", std::string{"medium"}), result.foveation))
        throw std::runtime_error("Invalid foveation quality");
    return result;
}
bool sameStored(const GraphicsControls &a, const GraphicsControls &b) {
    return a.renderScale == b.renderScale && a.foveation == b.foveation && a.fps == b.fps;
}
XrPosef pose7(const Json &value) {
    if (!value.is_array() || value.size() != 7)
        throw std::runtime_error("Expected a pose [x, y, z, qx, qy, qz, qw]");
    XrPosef pose;
    pose.position = {finite(value[0], 1000), finite(value[1], 1000), finite(value[2], 1000)};
    const float x = finite(value[3], 2), y = finite(value[4], 2), z = finite(value[5], 2),
                w = finite(value[6], 2);
    const float length = std::sqrt(x * x + y * y + z * z + w * w);
    if (length < .5f || length > 1.5f)
        throw std::runtime_error("Expected a unit quaternion");
    pose.orientation = {x / length, y / length, z / length, w / length};
    return pose;
}
float unit(const Json &hand, const char *key, float low) {
    return hand.contains(key) ? std::clamp(finite(hand[key], 10), low, 1.f) : 0.f;
}
bool flag(const Json &hand, const char *key) {
    if (!hand.contains(key))
        return false;
    if (!hand[key].is_boolean())
        throw std::runtime_error(std::string("Expected a boolean ") + key);
    return hand[key].get<bool>();
}
/** The page's capture puppet: {v: 1, hands: [hand | null, hand | null]} (capture_puppet.h). */
PuppetState puppetState(const Json &value) {
    if (!value.is_object() || value.value("v", 0) != 1)
        throw std::runtime_error("Unsupported puppet version");
    const auto &hands = value.at("hands");
    if (!hands.is_array() || hands.size() != 2)
        throw std::runtime_error("Expected two puppet hands");
    PuppetState out;
    for (size_t h = 0; h < 2; h++) {
        const auto &hand = hands[h];
        if (hand.is_null())
            continue;
        if (!hand.is_object())
            throw std::runtime_error("Expected a puppet hand");
        auto &slot = out.hands[h];
        const auto space = hand.value("space", std::string{"local"});
        if (space == "head")
            slot.space = PuppetSpace::Head;
        else if (space == "heading")
            slot.space = PuppetSpace::Heading;
        else if (space == "local")
            slot.space = PuppetSpace::Local;
        else
            throw std::runtime_error("Invalid puppet space");
        slot.grip = pose7(hand.at("grip"));
        slot.aim = pose7(hand.at("aim"));
        slot.trigger = unit(hand, "trigger", 0);
        slot.squeeze = unit(hand, "squeeze", 0);
        if (hand.contains("stick")) {
            const auto &stick = hand["stick"];
            if (!stick.is_array() || stick.size() != 2)
                throw std::runtime_error("Expected a puppet stick [x, y]");
            slot.stick = {std::clamp(finite(stick[0], 10), -1.f, 1.f),
                          std::clamp(finite(stick[1], 10), -1.f, 1.f)};
        }
        slot.primary = flag(hand, "a");
        slot.secondary = flag(hand, "b");
        slot.menu = flag(hand, "menu");
        slot.stickClick = flag(hand, "stickClick");
        slot.present = true;
    }
    return out;
}
std::string statusText(std::string value) {
    constexpr size_t limit = 4096;
    if (value.size() > limit) {
        size_t end = limit;
        while (end > 0 && (static_cast<unsigned char>(value[end]) & 0xc0) == 0x80)
            --end;
        value.resize(end);
    }
    return value;
}
} // namespace
bool BridgeState::submit(const std::string &packet, std::string &scene, std::string &error) {
    scene.clear();
    error.clear();
    if (packet.empty() || packet == "null")
        return false;
    if (packet.size() > 4 * 1024 * 1024) {
        error = "Bridge packet exceeds 4 MiB";
        return false;
    }
    try {
        auto parsed = Json::parse(packet, [](int depth, Json::parse_event_t, const Json &) {
            if (depth > 32)
                throw std::runtime_error("Bridge packet is nested too deeply");
            return true;
        });
        if (!parsed.is_object())
            return false;
        // Scene sequence numbers have already advanced in JavaScript. A malformed
        // control field must not drop an independently valid scene delta.
        if (parsed.contains("scene") && !parsed["scene"].is_null())
            scene = parsed["scene"].dump();
        ControlState next;
        bool pageGraphics = false;
        {
            std::lock_guard<std::mutex> lock(mutex);
            next = state;
        }
        next.haptics.clear();
        if (parsed.contains("control") && !parsed["control"].is_null()) {
            const auto &c = parsed.at("control");
            if (c.value("v", 0) != 1)
                throw std::runtime_error("Unsupported controls version");
            next.active = c.value("active", false);
            // Graphics change only when a page sends them, and never once the host owns them.
            if (c.contains("graphics") && !ownsGraphics()) {
                next.graphics = parseGraphics(c["graphics"]);
                pageGraphics = true;
            }
            if (c.contains("presentationEpoch")) {
                const auto &epoch = c["presentationEpoch"];
                if (!epoch.is_number_integer() ||
                    (epoch.is_number_integer() && !epoch.is_number_unsigned() &&
                     epoch.get<int64_t>() < 0) ||
                    epoch.get<uint64_t>() > UINT32_MAX)
                    throw std::runtime_error("Invalid presentation epoch");
                next.presentationEpoch = epoch.get<uint32_t>();
            } else
                next.presentationEpoch = 0;
            next.fade = std::clamp(finite(c.at("fade"), 1), 0.f, 1.f);
            const auto &matrix = c.at("matrix");
            if (!matrix.is_array() || matrix.size() != 16)
                throw std::runtime_error("Expected a rig matrix");
            for (int i = 0; i < 16; i++)
                next.rig[i] = finite(matrix[i]);
            const auto &hands = c.at("hands");
            if (!hands.is_array() || hands.size() != 2)
                throw std::runtime_error("Expected two hands");
            for (int h = 0; h < 2; h++) {
                auto &hover = next.hands[h];
                hover.holding = hands[h].value("holding", false);
                hover.valid = hands[h].contains("hover") && !hands[h]["hover"].is_null();
                if (hover.valid) {
                    hover.point = vector(hands[h]["hover"].at("point"));
                    hover.near = hands[h]["hover"].value("near", false);
                }
            }
            next.arc.clear();
            if (c.contains("teleport") && !c["teleport"].is_null()) {
                const auto &teleport = c["teleport"];
                const auto &points = teleport.at("points");
                if (!points.is_array() || points.size() > 300 || points.size() % 3)
                    throw std::runtime_error("Invalid teleport arc");
                for (size_t i = 0; i < points.size(); i += 3)
                    next.arc.push_back(
                        {finite(points[i]), finite(points[i + 1]), finite(points[i + 2])});
                next.marker = vector(teleport.at("marker"));
                next.teleportValid = teleport.value("valid", false);
            }
            // A malformed puppet clears it without rejecting the rest of the controls.
            next.puppet = PuppetState{};
            if (kCapturePuppetBuild && puppetAllowed && c.contains("puppet") &&
                !c["puppet"].is_null()) {
                try {
                    next.puppet = puppetState(c["puppet"]);
                } catch (const std::exception &invalid) {
                    error = std::string("Invalid capture puppet: ") + invalid.what();
                }
            }
            if (c.contains("haptics")) {
                const auto &haptics = c["haptics"];
                if (!haptics.is_array() || haptics.size() > 16)
                    throw std::runtime_error("Invalid haptic queue");
                for (const auto &pulse : haptics) {
                    int hand = pulse.at("hand").get<int>();
                    if (hand < 0 || hand > 1)
                        throw std::runtime_error("Invalid haptic hand");
                    next.haptics.push_back({hand,
                                            std::clamp(finite(pulse.at("strength"), 1), 0.f, 1.f),
                                            std::clamp(pulse.value("ms", 20), 1, 100)});
                }
            }
        }
        bool pageStatus = false;
        std::string aim, message;
        if (parsed.contains("panel")) {
            next.panelOpen = parsed["panel"].value("open", true);
            if (parsed["panel"].contains("status")) {
                const auto &status = parsed["panel"]["status"];
                aim = statusText(status.value("aim", std::string{}));
                message = statusText(status.value("message", std::string{}));
                pageStatus = true;
            }
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (pageStatus) {
                pageCounter = std::move(aim);
                pageMessage = std::move(message);
            }
            // The host may have changed graphics while this packet was parsed; its choice stands.
            if (hostOwned)
                next.graphics = state.graphics;
            composeStatus(next);
            if (pageGraphics && !hostOwned) {
                if (!graphicsReceived || !sameStored(next.graphics, state.graphics))
                    storedChanged = true;
                graphicsReceived = true;
            }
            next.revision = state.revision + 1;
            next.receivedNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count();
            state = std::move(next);
        }
        return true;
    } catch (const std::exception &e) {
        error = e.what();
        return false;
    }
}
ControlState BridgeState::read() {
    std::lock_guard<std::mutex> lock(mutex);
    auto result = state;
    state.haptics.clear();
    return result;
}
void BridgeState::allowPuppet(bool allowed) { puppetAllowed = kCapturePuppetBuild && allowed; }
void BridgeState::reset() {
    std::lock_guard<std::mutex> lock(mutex);
    auto revision = state.revision + 1;
    const auto graphics = state.graphics;
    state = ControlState{};
    state.revision = revision;
    state.graphics = graphics;
    pageCounter.clear();
    pageMessage.clear();
    composeStatus(state);
}
void BridgeState::seedGraphics(const GraphicsControls &graphics) {
    std::lock_guard<std::mutex> lock(mutex);
    if (graphicsReceived)
        return;
    state.graphics = hostOwned ? hostGraphics(graphics) : graphics;
    state.graphics.foveationDebug = false;
    composeStatus(state);
}
void BridgeState::ownGraphics() {
    std::lock_guard<std::mutex> lock(mutex);
    if (hostOwned)
        return;
    hostOwned = true;
    state.graphics = hostGraphics(state.graphics);
    composeStatus(state);
}
bool BridgeState::ownsGraphics() {
    std::lock_guard<std::mutex> lock(mutex);
    return hostOwned;
}
bool BridgeState::setGraphics(const GraphicsControls &graphics) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!hostOwned)
        return false;
    const auto next = hostGraphics(graphics);
    if (!graphicsReceived || !sameStored(next, state.graphics))
        storedChanged = true;
    graphicsReceived = true;
    state.graphics = next;
    composeStatus(state);
    return true;
}
void BridgeState::setCounter(const std::string &text) {
    std::lock_guard<std::mutex> lock(mutex);
    hostCounter = statusText(text);
    composeStatus(state);
}
void BridgeState::composeStatus(ControlState &target) const {
    const std::string &counter =
        hostOwned ? (target.graphics.fps ? hostCounter : std::string{}) : pageCounter;
    target.status = Json{{"aim", counter}, {"message", pageMessage}}.dump(-1, ' ', true);
    target.statusCounter = !counter.empty();
    target.statusMessage = !pageMessage.empty();
    target.statusVisible = target.statusCounter || target.statusMessage;
}
GraphicsControls BridgeState::graphics() {
    std::lock_guard<std::mutex> lock(mutex);
    return state.graphics;
}
bool BridgeState::takeStoredGraphics(GraphicsControls &graphics) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!storedChanged)
        return false;
    storedChanged = false;
    graphics = state.graphics;
    return true;
}
std::string storedGraphics(const GraphicsControls &graphics) {
    return Json{{"v", 1},
                {"renderScale", graphics.renderScale},
                {"foveation", foveationQualityName(graphics.foveation)},
                {"fps", graphics.fps}}
        .dump();
}
bool restoreGraphics(const std::string &text, GraphicsControls &graphics) {
    try {
        const auto parsed = Json::parse(text);
        const auto stored = parseGraphics(parsed);
        graphics.renderScale = stored.renderScale;
        graphics.foveation = stored.foveation;
        graphics.fps = stored.fps;
        return true;
    } catch (const std::exception &) {
        return false;
    }
}
GraphicsControls hostGraphics(GraphicsControls graphics) {
    graphics.renderScale =
        std::isfinite(graphics.renderScale) ? std::clamp(graphics.renderScale, .75f, 2.f) : 1.f;
    // The Vulkan renderer has neither the sharp-screen layer nor the density diagnostic.
    graphics.sharpScreens = false;
    graphics.foveationDebug = false;
    return graphics;
}
std::string graphicsEvent(const GraphicsControls &graphics) {
    return Json{{"v", 1},
                {"renderScale", graphics.renderScale},
                {"foveation", foveationQualityName(graphics.foveation)},
                {"fps", graphics.fps},
                {"sharpScreens", graphics.sharpScreens},
                {"foveationDebug", graphics.foveationDebug}}
        .dump();
}
namespace {
const Json *number(const Json &m, const char *key) {
    const auto found = m.find(key);
    return found != m.end() && found->is_number() && std::isfinite(found->get<double>()) ? &*found
                                                                                         : nullptr;
}
Json eyeSize(const Json &m, const char *width, const char *height) {
    const auto *w = number(m, width), *h = number(m, height);
    if (!w || !h || w->get<double>() < 1 || h->get<double>() < 1)
        return nullptr;
    return {{"width", static_cast<int>(w->get<double>())},
            {"height", static_cast<int>(h->get<double>())}};
}
} // namespace
std::string fpsCounterText(const std::string &metrics) {
    const auto m = Json::parse(metrics, nullptr, false);
    if (!m.is_object())
        return "Measuring FPS…";
    if (m.value("focused", true) == false)
        return "Session paused";
    char buffer[64];
    std::string text = "Measuring FPS…";
    if (const auto *fps = number(m, "fps"); fps && fps->get<double>() >= 0) {
        snprintf(buffer, sizeof(buffer), "%.1f fps", fps->get<double>());
        text = buffer;
    }
    if (const auto *refresh = number(m, "refresh"); refresh && refresh->get<double>() > 0) {
        snprintf(buffer, sizeof(buffer), " · %d Hz",
                 static_cast<int>(std::lround(refresh->get<double>())));
        text += buffer;
    }
    if (const auto *age = number(m, "controlAgeMs"); age && age->get<double>() > 1000)
        text += " · Office delayed";
    return text;
}
std::string graphicsStatus(const GraphicsControls &graphics, const std::string &metrics) {
    auto m = Json::parse(metrics, nullptr, false);
    if (!m.is_object())
        m = Json::object();
    Json out = {{"graphics", Json::parse(graphicsEvent(graphics))},
                {"recommended", eyeSize(m, "worldRecommendedWidth", "worldRecommendedHeight")},
                {"maximum", eyeSize(m, "worldMaxWidth", "worldMaxHeight")},
                {"applied", eyeSize(m, "worldWidth", "worldHeight")},
                {"selected", nullptr},
                {"maxRenderScale", nullptr},
                {"appliedFoveation", nullptr},
                {"pending", false},
                {"error", m.value("graphicsError", std::string{})},
                {"counter", fpsCounterText(metrics)}};
    const bool known = !out["recommended"].is_null() && !out["maximum"].is_null();
    if (known) {
        ResolutionLimits limits{
            {out["recommended"]["width"].get<int>(), out["recommended"]["height"].get<int>()},
            {out["maximum"]["width"].get<int>(), out["maximum"]["height"].get<int>()}};
        const auto selected = renderSize(limits, graphics.renderScale);
        out["selected"] = {{"width", selected.width}, {"height", selected.height}};
        out["maxRenderScale"] = std::max(.75f, maximumRenderScale(limits));
    }
    if (m.contains("foveationLevel") && m["foveationLevel"].is_string())
        out["appliedFoveation"] = m.value("foveationEnabled", false)
                                      ? m["foveationLevel"].get<std::string>()
                                      : std::string{"off"};
    const bool sizePending = known && out["selected"] != out["applied"];
    const bool foveationPending =
        out["appliedFoveation"].is_string() &&
        out["appliedFoveation"].get<std::string>() != foveationQualityName(graphics.foveation);
    out["pending"] = out["applied"].is_null() || sizePending || foveationPending;
    return out.dump(-1, ' ', true);
}
} // namespace office
