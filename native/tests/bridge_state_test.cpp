#include "bridge_state.h"
#include "frame_metrics.h"
#include "json.hpp"
#include "panel_pointer.h"
#include <cassert>
#include <cmath>
#include <iostream>

using namespace office;
using Json = nlohmann::json;
bool close(float a, float b) { return std::abs(a - b) < .00001f; }
void math() {
    XrPosef rig{yaw(.73f), {12, 3, -4}}, eye{{0, 0, 0, 1}, {.3f, 1.6f, -.1f}};
    auto world = compose(rig, eye);
    auto matrix = multiply(transform(rig), transform(eye));
    auto point = transformPoint(matrix, {0, 0, 0});
    assert(close(point.x, world.position.x) && close(point.y, world.position.y) &&
           close(point.z, world.position.z));
    auto identity = multiply(inverseRigid(matrix), matrix);
    for (int i = 0; i < 16; i++)
        assert(close(identity[i], i % 5 == 0 ? 1 : 0));
    auto view = multiply(inverse(eye), inverseRigid(transform(rig)));
    auto origin = transformPoint(view, world.position);
    assert(close(origin.x, 0) && close(origin.y, 0) && close(origin.z, 0));
    float x = 0, y = 0, distance = 0;
    XrPosef panel{yaw(.5f), {2, 1, -3}}, ray = compose(panel, {{0, 0, 0, 1}, {0, 0, 1}});
    assert(panelHit(ray, panel, 1.8f, 1.2f, x, y, distance));
    assert(close(x, .5f) && close(y, .5f) && close(distance, 1));
    ray.orientation = multiply(ray.orientation, yaw(3.14159265f));
    assert(!panelHit(ray, panel, 1.8f, 1.2f, x, y, distance));
    auto p = projection({-.8f, .7f, .75f, -.7f});
    assert(std::isfinite(p[0]) && p[0] > 0 && p[5] > 0 && p[11] == -1);
}
void packets() {
    BridgeState bridge;
    Json packet = {
        {"scene", {{"v", 1}, {"seq", 1}, {"reset", true}}},
        {"panel",
         {{"open", false}, {"status", {{"aim", "Open worker 🧑‍💻"}, {"message", "Ready"}}}}},
        {"control",
         {{"v", 1},
          {"active", true},
          {"presentationEpoch", 23},
          {"fade", .5},
          {"matrix", transform({yaw(.3f), {4, 0, -5}})},
          {"hands",
           Json::array({{{"holding", true}, {"hover", nullptr}},
                        {{"holding", false}, {"hover", {{"point", {1, 2, 3}}, {"near", true}}}}})},
          {"teleport", {{"points", {1, 2, 3, 4, 5, 6}}, {"marker", {4, 5, 6}}, {"valid", true}}},
          {"haptics", Json::array({{{"hand", 1}, {"strength", .4}, {"ms", 30}}})}}}};
    std::string scene, error;
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    assert(Json::parse(scene)["seq"] == 1);
    auto state = bridge.read();
    assert(state.active && !state.panelOpen && close(state.fade, .5f));
    assert(state.presentationEpoch == 23 && state.receivedNs > 0);
    assert(state.statusVisible && Json::parse(state.status)["aim"] == "Open worker 🧑‍💻");
    for (unsigned char ch : state.status)
        assert(ch < 128);
    assert(state.hands[0].holding && !state.hands[0].valid && state.hands[1].valid &&
           state.hands[1].near);
    assert(state.arc.size() == 2 && state.teleportValid && state.haptics.size() == 1);
    assert(bridge.read().haptics.empty());
    const auto revision = state.revision;
    const auto receivedNs = state.receivedNs;
    const auto validControl = packet["control"];
    packet["scene"]["seq"] = 2;
    packet["control"]["matrix"] = Json::array({1, 2});
    error.clear();
    assert(!bridge.submit(packet.dump(), scene, error) && !error.empty());
    assert(Json::parse(scene)["seq"] == 2 && "control failure preserves the scene delta");
    assert(bridge.read().revision == revision);
    assert(bridge.read().receivedNs == receivedNs);
    packet["control"] = validControl;
    packet["panel"]["status"]["message"] = std::string(4095, 'x') + "🧑‍💻";
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    state = bridge.read();
    assert(Json::parse(state.status)["message"] == std::string(4095, 'x'));
    assert(Json::parse(scene)["seq"] == 2);
    const auto beforeEpochErrors = bridge.read().revision;
    for (const auto &invalid : Json::array({-1, 4294967296ULL, .5, "1", true, nullptr})) {
        packet["control"]["presentationEpoch"] = invalid;
        assert(!bridge.submit(packet.dump(), scene, error) && !error.empty());
        assert(bridge.read().revision == beforeEpochErrors);
        assert(Json::parse(scene)["seq"] == 2);
    }
    packet["control"]["presentationEpoch"] = UINT32_MAX;
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().presentationEpoch == UINT32_MAX);
    packet["control"].erase("presentationEpoch");
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().presentationEpoch == 0 && "old producers remain compatible");
    assert(bridge.read().graphics.sharpScreens);
    packet["control"]["graphics"] = {
        {"v", 1}, {"renderScale", 1}, {"peripheralDensity", .25}, {"sharpScreens", false}};
    assert(bridge.submit(packet.dump(), scene, error));
    assert(!bridge.read().graphics.sharpScreens);
    packet["control"]["graphics"].erase("sharpScreens");
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().graphics.sharpScreens && "legacy settings keep laptop clarity enabled");
    const auto graphicsRevision = bridge.read().revision;
    for (const auto &invalid : Json::array({"false", 0, nullptr})) {
        packet["control"]["graphics"]["sharpScreens"] = invalid;
        assert(!bridge.submit(packet.dump(), scene, error));
        assert(bridge.read().revision == graphicsRevision);
        assert(bridge.read().graphics.sharpScreens);
    }
    error.clear();
    assert(!bridge.submit("{broken", scene, error) && !error.empty());
    assert(scene.empty());
    error.clear();
    assert(!bridge.submit(std::string(4 * 1024 * 1024 + 1, ' '), scene, error) && !error.empty());
    error.clear();
    std::string nested(40, '[');
    nested += '0';
    nested += std::string(40, ']');
    assert(!bridge.submit(nested, scene, error) && !error.empty());
    assert(!bridge.submit("null", scene, error));
    bridge.reset();
    state = bridge.read();
    assert(!state.active && state.panelOpen && state.arc.empty() && state.fade == 0);
    assert(state.presentationEpoch == 0 && state.receivedNs == 0);
}
void pointerEvents() {
    PanelPointer pointer;
    PanelPointer::Sample sample{true, true, false, true, 0, 120, 240};
    assert(pointer.step(0, sample).action == -1);
    sample.trigger = .8f;
    assert(pointer.step(0, sample).action == 0);
    sample.trigger = .7f;
    assert(pointer.step(0, sample).action == 2); // Hold through the hysteresis band.
    sample.trigger = .5f;
    assert(pointer.step(0, sample).action == 1);
    sample.hit = false;
    sample.trigger = 1;
    assert(pointer.step(0, sample).action == -1);
    sample.hit = true;
    assert(pointer.step(0, sample).action == -1); // Sweeping a held trigger onto UI cannot click.
    sample.trigger = 0;
    pointer.step(0, sample);
    sample.trigger = 1;
    assert(pointer.step(0, sample).action == 0);
    sample.active = false;
    assert(pointer.step(0, sample).action == 3); // Tracking loss cancels; UP would click.
    sample.active = true;
    assert(pointer.step(0, sample).action == -1); // Reconnect with trigger held cannot click.
    sample.trigger = 0;
    pointer.step(0, sample);
    sample.trigger = 1;
    assert(pointer.step(0, sample).action == 0);
    sample.hit = false;
    sample.trigger = 0;
    assert(pointer.step(0, sample).action == 3); // Releasing outside the panel cancels.
    sample.hit = true;
    pointer.step(0, sample);
    sample.trigger = 1;
    assert(pointer.step(0, sample).action == 0);
    sample.holding = true;
    assert(pointer.step(0, sample).action == 3); // Grabs keep ownership of that hand.
    sample.holding = false;
    sample.trigger = 0;
    pointer.step(0, sample);
    sample.trigger = 1;
    assert(pointer.step(0, sample).action == 0);
    auto other = sample;
    other.trigger = 0;
    pointer.step(1, other);
    other.trigger = 1;
    assert(pointer.step(1, other).action == -1); // Only one Android touch stream.
    sample.panelOpen = false;
    assert(pointer.step(0, sample).action == 3);
}
void hoverEvents() {
    PanelHover hover;
    std::array<PanelHover::Sample, 2> rays{{{true, 100, 150}, {true, 400, 450}}};
    auto event = hover.step(rays, false, 1);
    assert(event.action == 9 && event.x == 400);
    assert(hover.step(rays, false, 1.1).action == -1);
    rays[1].x += 10;
    assert(hover.step(rays, false, 1.01).action == -1);
    assert(hover.step(rays, false, 1.04).action == 7);
    rays[0].x += 100;
    assert(hover.step(rays, false, 1.08).action == -1 && "other ray cannot steal hover");
    assert(hover.step(rays, true, 1.1).action == 10 && "press ends hover without a mouse click");
    assert(hover.step(rays, true, 1.15).action == -1);
    assert(hover.step(rays, false, 1.2).action == 9);
    rays[1].hit = false;
    assert(hover.step(rays, false, 1.24).action == 7);
    rays[0].hit = false;
    assert(hover.step(rays, false, 1.3).action == 10);
    assert(hover.step(rays, false, 1.4).action == -1);
}
int main() {
    math();
    packets();
    pointerEvents();
    hoverEvents();
    assert(FrameMetrics::percentile({3, 1, 4, 2}, .5) == 3);
    assert(FrameMetrics::percentile({3, 1, 4, 2}, 1) == 4);
    assert(FrameMetrics::percentile({}, .99) == 0);
    std::cout << "Native pose, panel-ray, bridge validation and metric tests passed\n";
}
