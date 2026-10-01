#include "bridge_state.h"
#include "json.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>

namespace office {
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
            next.graphics = GraphicsControls{};
            if (c.contains("graphics")) {
                const auto &graphics = c["graphics"];
                if (!graphics.is_object() || graphics.value("v", 0) != 1)
                    throw std::runtime_error("Unsupported graphics version");
                next.graphics.sharpScreens = graphics.value("sharpScreens", true);
                next.graphics.renderScale =
                    std::clamp(finite(graphics.at("renderScale")), .75f, 2.f);
                next.graphics.peripheralDensity =
                    std::clamp(finite(graphics.at("peripheralDensity"), 1), .25f, 1.f);
                const auto quality = graphics.value("foveation", std::string{"balanced"});
                if (quality == "clarity")
                    next.graphics.foveation = FoveationQuality::Clarity;
                else if (quality == "performance")
                    next.graphics.foveation = FoveationQuality::Performance;
                else if (quality == "off")
                    next.graphics.foveation = FoveationQuality::Off;
                else if (quality != "balanced")
                    throw std::runtime_error("Invalid foveation quality");
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
        if (parsed.contains("panel")) {
            next.panelOpen = parsed["panel"].value("open", true);
            if (parsed["panel"].contains("status")) {
                const auto &status = parsed["panel"]["status"];
                auto aim = statusText(status.value("aim", std::string{}));
                auto message = statusText(status.value("message", std::string{}));
                next.status = Json{{"aim", aim}, {"message", message}}.dump(-1, ' ', true);
                next.statusVisible = !aim.empty() || !message.empty();
            }
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
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
    state = ControlState{};
    state.revision = revision;
}
} // namespace office
