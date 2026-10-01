#include "bridge_state.h"
#include "frame_metrics.h"
#include "json.hpp"
#include "native_settings.h"
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
    assert(state.statusCounter && state.statusMessage);
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
    // The counter and the toast are composited as separate layers, so each is flagged.
    const auto validStatus = packet["panel"]["status"];
    packet["panel"]["status"] = {{"aim", "90.0 fps · 90 Hz"}, {"message", ""}};
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    state = bridge.read();
    assert(state.statusVisible && state.statusCounter && !state.statusMessage);
    packet["panel"]["status"] = {{"aim", ""}, {"message", "Pixel is ready"}};
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    state = bridge.read();
    assert(state.statusVisible && !state.statusCounter && state.statusMessage);
    packet["panel"]["status"] = {{"aim", ""}, {"message", ""}};
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    state = bridge.read();
    assert(!state.statusVisible && !state.statusCounter && !state.statusMessage);
    packet["panel"]["status"] = validStatus;
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
    packet["control"]["graphics"]["renderScale"] = 1.7;
    packet["control"]["graphics"]["foveation"] = "off";
    assert(bridge.submit(packet.dump(), scene, error));
    assert(close(bridge.read().graphics.renderScale, 1.7f));
    assert(bridge.read().graphics.foveation == FoveationQuality::Off);
    packet["control"]["graphics"]["renderScale"] = 4;
    assert(bridge.submit(packet.dump(), scene, error));
    assert(close(bridge.read().graphics.renderScale, 2.f));
    packet["control"]["graphics"]["renderScale"] = .1;
    assert(bridge.submit(packet.dump(), scene, error));
    assert(close(bridge.read().graphics.renderScale, .75f));
    packet["control"]["graphics"]["renderScale"] = 1;
    packet["control"]["graphics"]["foveation"] = "balanced";
    assert(bridge.submit(packet.dump(), scene, error));
    assert(!bridge.read().graphics.foveationDebug && "the diagnostic view is off by default");
    packet["control"]["graphics"]["foveationDebug"] = true;
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().graphics.foveationDebug);
    for (const auto &quality : {"clarity", "performance", "off", "balanced"}) {
        packet["control"]["graphics"]["foveation"] = quality;
        assert(bridge.submit(packet.dump(), scene, error));
    }
    for (const auto &quality : {"low", "high", "off", "medium"}) {
        packet["control"]["graphics"]["foveation"] = quality;
        assert(bridge.submit(packet.dump(), scene, error));
    }
    assert(bridge.read().graphics.foveation == FoveationQuality::Balanced);
    // Current pages no longer send peripheralDensity; older pages still do.
    packet["control"]["graphics"].erase("peripheralDensity");
    packet["control"]["graphics"].erase("foveationDebug");
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    assert(!bridge.read().graphics.foveationDebug);
    packet["control"]["graphics"]["peripheralDensity"] = 7;
    assert(bridge.submit(packet.dump(), scene, error) && "legacy density is ignored, not rejected");
    packet["control"]["graphics"].erase("peripheralDensity");
    const auto debugRevision = bridge.read().revision;
    packet["control"]["graphics"]["foveationDebug"] = "true";
    assert(!bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().revision == debugRevision);
    packet["control"]["graphics"].erase("foveationDebug");
    packet["control"]["graphics"]["foveation"] = "maximum";
    assert(!bridge.submit(packet.dump(), scene, error));
    packet["control"]["graphics"]["foveation"] = "balanced";
    assert(bridge.submit(packet.dump(), scene, error));
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
    packet["control"]["graphics"]["sharpScreens"] = true;
    packet["control"]["graphics"]["foveation"] = "off";
    packet["control"]["graphics"]["renderScale"] = 1.25;
    assert(bridge.submit(packet.dump(), scene, error));
    bridge.reset();
    state = bridge.read();
    assert(!state.active && state.panelOpen && state.arc.empty() && state.fade == 0);
    assert(state.presentationEpoch == 0 && state.receivedNs == 0);
    assert(state.graphics.foveation == FoveationQuality::Off &&
           close(state.graphics.renderScale, 1.25f) &&
           "a reloading page keeps the world targets until it sends its settings");
    // A control packet without graphics leaves them as they are.
    packet["control"].erase("graphics");
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.read().graphics.foveation == FoveationQuality::Off);
}
void storedSettings() {
    // The settings kept between launches: render scale, foveation and the FPS counter.
    GraphicsControls page;
    page.renderScale = 1.16f;
    page.foveation = FoveationQuality::Off;
    page.sharpScreens = false;
    page.foveationDebug = true;
    const auto text = storedGraphics(page);
    GraphicsControls restored;
    assert(restoreGraphics(text, restored));
    assert(close(restored.renderScale, 1.16f) && restored.foveation == FoveationQuality::Off);
    assert(restored.sharpScreens && !restored.foveationDebug && "only targets are restored");
    for (const auto *quality : {"low", "high", "medium", "off"}) {
        GraphicsControls value;
        assert(restoreGraphics(Json{{"v", 1}, {"renderScale", 1}, {"foveation", quality}}.dump(),
                               value));
        assert(Json::parse(storedGraphics(value))["foveation"] == quality);
    }
    const Json oldNames = {{"clarity", "low"}, {"balanced", "medium"}, {"performance", "high"}};
    for (const auto &[oldName, level] : oldNames.items()) {
        GraphicsControls value;
        assert(restoreGraphics(Json{{"v", 1}, {"renderScale", 1}, {"foveation", oldName}}.dump(),
                               value));
        assert(Json::parse(storedGraphics(value))["foveation"] == level);
    }
    for (const auto &broken :
         {std::string(""), std::string("{"), std::string("null"), std::string("[]"),
          Json{{"v", 2}, {"renderScale", 1}}.dump(), Json{{"v", 1}}.dump(),
          Json{{"v", 1}, {"renderScale", "1"}}.dump(),
          Json{{"v", 1}, {"renderScale", 1}, {"foveation", "maximum"}}.dump()}) {
        GraphicsControls value;
        value.renderScale = 1.5f;
        assert(!restoreGraphics(broken, value) && close(value.renderScale, 1.5f));
    }
    GraphicsControls clamped;
    assert(restoreGraphics(Json{{"v", 1}, {"renderScale", 9}}.dump(), clamped));
    assert(close(clamped.renderScale, 2.f) && clamped.foveation == FoveationQuality::Balanced);

    // The stored copy is used until a page sends its own settings, which then win for good.
    BridgeState bridge;
    bridge.seedGraphics(restored);
    assert(bridge.graphics().foveation == FoveationQuality::Off);
    GraphicsControls changed;
    assert(!bridge.takeStoredGraphics(changed) && "seeding is not a page change");
    Json packet = {
        {"control",
         {{"v", 1},
          {"fade", 0},
          {"matrix", transform({{0, 0, 0, 1}, {0, 0, 0}})},
          {"hands", Json::array({Json::object(), Json::object()})},
          {"graphics", {{"v", 1}, {"renderScale", 1.16}, {"foveation", "off"}, {"fps", true}}}}}};
    std::string scene, error;
    assert(bridge.submit(packet.dump(), scene, error) && error.empty());
    assert(bridge.takeStoredGraphics(changed) && changed.foveation == FoveationQuality::Off &&
           "the first page settings are stored");
    assert(!bridge.takeStoredGraphics(changed) && "once");
    assert(bridge.submit(packet.dump(), scene, error));
    assert(!bridge.takeStoredGraphics(changed) && "unchanged settings are not stored again");
    packet["control"]["graphics"]["foveationDebug"] = true;
    packet["control"]["graphics"]["sharpScreens"] = false;
    assert(bridge.submit(packet.dump(), scene, error));
    assert(!bridge.takeStoredGraphics(changed) && "the diagnostic and sharp screens are not kept");
    packet["control"]["graphics"]["foveation"] = "performance";
    assert(bridge.submit(packet.dump(), scene, error));
    assert(bridge.takeStoredGraphics(changed) &&
           changed.foveation == FoveationQuality::Performance);
    GraphicsControls stale;
    stale.foveation = FoveationQuality::Clarity;
    bridge.seedGraphics(stale);
    assert(bridge.graphics().foveation == FoveationQuality::Performance &&
           "a stored copy never replaces settings a page sent");
    bridge.reset();
    assert(bridge.graphics().foveation == FoveationQuality::Performance);

    // The FPS counter is stored too; copies from before it existed restore it as off.
    GraphicsControls counter;
    counter.fps = true;
    assert(restoreGraphics(storedGraphics(counter), restored) && restored.fps);
    assert(restoreGraphics(Json{{"v", 1}, {"renderScale", 1.2}, {"foveation", "clarity"}}.dump(),
                           restored));
    assert(!restored.fps && restored.foveation == FoveationQuality::Clarity &&
           Json::parse(storedGraphics(restored))["foveation"] == "low" &&
           "a legacy copy migrates to the runtime names when it is next written");
}
Json controlPacket(const Json &graphics) {
    Json packet = {
        {"control",
         {{"v", 1},
          {"active", true},
          {"fade", 0},
          {"matrix", transform({{0, 0, 0, 1}, {0, 0, 0}})},
          {"hands", Json::array({Json::object(), Json::object()})}}},
        {"panel", {{"open", false}, {"status", {{"aim", "60.0 fps"}, {"message", ""}}}}}};
    if (!graphics.is_null())
        packet["control"]["graphics"] = graphics;
    return packet;
}
void hostAuthority() {
    BridgeState bridge;
    std::string scene, error;
    GraphicsControls stored;
    stored.renderScale = 1.35f;
    stored.foveation = FoveationQuality::Off;
    stored.fps = true;
    stored.sharpScreens = true;
    bridge.ownGraphics();
    bridge.seedGraphics(stored);
    assert(bridge.ownsGraphics());
    auto g = bridge.graphics();
    assert(close(g.renderScale, 1.35f) && g.foveation == FoveationQuality::Off && g.fps);
    assert(!g.sharpScreens && !g.foveationDebug && "the Vulkan host claims no sharp-screen pass");
    GraphicsControls taken;
    assert(!bridge.takeStoredGraphics(taken) && "restoring is not a change");

    // A stale or older page's graphics never overwrite the host's, and cannot reject a packet.
    const Json stale = {{"v", 1},
                        {"renderScale", .8},
                        {"foveation", "performance"},
                        {"fps", false},
                        {"sharpScreens", true},
                        {"foveationDebug", true},
                        {"peripheralDensity", .25}};
    assert(bridge.submit(controlPacket(stale).dump(), scene, error) && error.empty());
    g = bridge.read().graphics;
    assert(close(g.renderScale, 1.35f) && g.foveation == FoveationQuality::Off && g.fps &&
           !g.foveationDebug);
    assert(!bridge.takeStoredGraphics(taken) && "page graphics are never stored");
    assert(bridge.submit(controlPacket(Json{{"v", 9}, {"foveation", "maximum"}}).dump(), scene,
                         error) &&
           error.empty() && "invalid page graphics are ignored, not parsed");
    assert(bridge.submit(controlPacket(nullptr).dump(), scene, error) &&
           "modern pages omit graphics");

    // The host's choice applies at once, with no packet in between, and is stored once.
    GraphicsControls chosen = bridge.graphics();
    chosen.renderScale = 1.6f;
    chosen.foveation = FoveationQuality::Performance;
    chosen.sharpScreens = true;
    chosen.foveationDebug = true;
    assert(bridge.setGraphics(chosen));
    g = bridge.graphics();
    assert(close(g.renderScale, 1.6f) && g.foveation == FoveationQuality::Performance);
    assert(!g.sharpScreens && !g.foveationDebug);
    assert(bridge.takeStoredGraphics(taken) && close(taken.renderScale, 1.6f));
    assert(!bridge.takeStoredGraphics(taken));
    assert(bridge.setGraphics(chosen) && !bridge.takeStoredGraphics(taken) &&
           "an unchanged choice is not written again");
    chosen.renderScale = 9;
    assert(bridge.setGraphics(chosen) && close(bridge.graphics().renderScale, 2.f));
    chosen.renderScale = std::nanf("");
    assert(bridge.setGraphics(chosen) && close(bridge.graphics().renderScale, 1.f));
    chosen.renderScale = 1.6f;
    assert(bridge.setGraphics(chosen));
    assert(bridge.submit(controlPacket(stale).dump(), scene, error));
    assert(bridge.read().graphics.foveation == FoveationQuality::Performance &&
           "a packet parsed before or after a host change cannot undo it");
    bridge.reset();
    assert(bridge.graphics().foveation == FoveationQuality::Performance && "reloads keep it");
    GraphicsControls older;
    older.foveation = FoveationQuality::Clarity;
    bridge.seedGraphics(older);
    assert(bridge.graphics().foveation == FoveationQuality::Performance &&
           "a late stored copy never replaces a choice made since");

    // The mirror the page reads: canonical version-one names.
    const auto event = Json::parse(graphicsEvent(bridge.graphics()));
    assert(event == (Json{{"v", 1},
                          {"renderScale", event["renderScale"]},
                          {"foveation", "high"},
                          {"fps", g.fps},
                          {"sharpScreens", false},
                          {"foveationDebug", false}}));
    assert(close(event["renderScale"].get<float>(), 1.6f));

    // A host that does not own graphics refuses host changes (older behaviour stays).
    BridgeState page;
    assert(!page.setGraphics(chosen) && !page.ownsGraphics());
}
void hostCounter() {
    BridgeState bridge;
    std::string scene, error;
    bridge.ownGraphics();
    GraphicsControls g = bridge.graphics();
    g.fps = false;
    assert(bridge.setGraphics(g));
    Json packet = controlPacket(nullptr);
    packet["panel"]["status"] = {{"aim", "page counter"}, {"message", "Pixel is ready"}};
    assert(bridge.submit(packet.dump(), scene, error));
    auto state = bridge.read();
    assert(Json::parse(state.status)["aim"] == "" && state.statusMessage && !state.statusCounter &&
           "the page's counter text is ignored on a host-owned host");
    g.fps = true;
    assert(bridge.setGraphics(g));
    bridge.setCounter("90.0 fps · 90 Hz");
    state = bridge.read();
    assert(Json::parse(state.status)["aim"] == "90.0 fps · 90 Hz" && state.statusCounter);
    assert(Json::parse(state.status)["message"] == "Pixel is ready" && "the toast is kept");
    packet["panel"]["status"] = {{"aim", ""}, {"message", ""}};
    assert(bridge.submit(packet.dump(), scene, error));
    state = bridge.read();
    assert(state.statusCounter && !state.statusMessage && state.statusVisible);
    bridge.reset();
    state = bridge.read();
    assert(state.statusCounter && !state.statusMessage && "the counter survives a page reload");

    assert(fpsCounterText("{}") == "Measuring FPS…");
    assert(fpsCounterText("not json") == "Measuring FPS…");
    assert(fpsCounterText(R"({"fps":89.96,"refresh":90.0})") == "90.0 fps · 90 Hz");
    assert(fpsCounterText(R"({"fps":72.2,"refresh":90,"controlAgeMs":1500})") ==
           "72.2 fps · 90 Hz · Office delayed");
    assert(fpsCounterText(R"({"fps":90,"focused":false})") == "Session paused");
    assert(fpsCounterText(R"({"fps":null,"refresh":null,"controlAgeMs":null})") ==
           "Measuring FPS…");
}
void settingsStatus() {
    GraphicsControls g;
    g.renderScale = 1.5f;
    g.foveation = FoveationQuality::Performance;
    auto s = Json::parse(graphicsStatus(g, "{}"));
    assert(s["recommended"].is_null() && s["maximum"].is_null() && s["applied"].is_null());
    assert(s["selected"].is_null() && s["maxRenderScale"].is_null() && s["pending"] == true);
    assert(s["graphics"]["foveation"] == "high" && s["counter"] == "Measuring FPS…");
    // A runtime maximum that is not a whole 5% stop: 3000 / 2064 = 1.4535 of recommended.
    const Json metrics = {{"worldRecommendedWidth", 2064},
                          {"worldRecommendedHeight", 2208},
                          {"worldMaxWidth", 3000},
                          {"worldMaxHeight", 4000},
                          {"worldWidth", 2064},
                          {"worldHeight", 2208},
                          {"foveationLevel", "medium"},
                          {"foveationEnabled", true},
                          {"graphicsError", ""},
                          {"fps", 90},
                          {"refresh", 90}};
    s = Json::parse(graphicsStatus(g, metrics.dump()));
    assert(close(s["maxRenderScale"].get<float>(), 3000.f / 2064));
    ResolutionLimits limits{{2064, 2208}, {3000, 4000}};
    const auto selected = renderSize(limits, g.renderScale);
    assert(s["selected"] == (Json{{"width", selected.width}, {"height", selected.height}}));
    assert(selected.width <= 3000 && "the selection is bounded by the runtime maximum");
    assert(s["applied"] == (Json{{"width", 2064}, {"height", 2208}}));
    assert(s["appliedFoveation"] == "medium" && s["pending"] == true &&
           "the applied targets are reported, not the selection");
    auto bound = metrics;
    bound["worldWidth"] = selected.width;
    bound["worldHeight"] = selected.height;
    bound["foveationLevel"] = "high";
    s = Json::parse(graphicsStatus(g, bound.dump()));
    assert(s["pending"] == false && s["appliedFoveation"] == "high");
    g.foveation = FoveationQuality::Off;
    bound["foveationLevel"] = "off";
    bound["foveationEnabled"] = false;
    s = Json::parse(graphicsStatus(g, bound.dump()));
    assert(s["appliedFoveation"] == "off" && s["pending"] == false);
    bound["graphicsError"] = "Could not allocate the world targets";
    s = Json::parse(graphicsStatus(g, bound.dump()));
    assert(s["error"] == "Could not allocate the world targets");
    s = Json::parse(graphicsStatus(g, "broken"));
    assert(s["recommended"].is_null() && s["graphics"]["v"] == 1);
}
void settingsButton() {
    SettingsMenuButton button;
    assert(!button.step(true, true) && "held when tracking starts: wait for release");
    assert(!button.step(true, true));
    assert(!button.step(true, false));
    assert(button.step(true, true) && "fresh press");
    assert(!button.step(true, true) && "holding is one press");
    assert(!button.step(true, false));
    assert(button.step(true, true));
    assert(!button.step(false, true) && "tracking lost while held");
    assert(!button.step(true, true) && "a stale press is not replayed");
    assert(!button.step(true, false));
    assert(!button.step(false, false));
    assert(!button.step(true, true) && "returning tracking must see a release first");
    assert(!button.step(true, false));
    assert(button.step(true, true));
}
void workspacePanel() {
    WorkspacePanel panel;
    assert(!panel.step(false, false, false, false, 0));
    assert(panel.step(false, false, true, false, 10) && "settings open the quad without the page");
    assert(panel.step(false, true, false, false, 20) && "Android dialogs open it");
    assert(panel.step(true, false, true, false, 30) && "settings over an open workspace");
    assert(panel.step(true, false, false, false, 40) && "closing settings returns to it");
    assert(!panel.step(false, false, false, false, 50) && "closing settings alone closes it");
    assert(panel.step(false, false, true, false, 60));
    assert(panel.step(false, false, false, true, 70) && "Office workspace holds the quad");
    assert(panel.step(false, false, false, false, 500) && "until the page answers");
    assert(panel.step(true, false, false, false, 600) && "the page's workspace takes over");
    assert(!panel.step(false, false, false, false, 700) && "and its close is honoured");
    assert(panel.step(false, false, false, true, 800));
    assert(panel.step(false, false, false, false, 1800));
    assert(!panel.step(false, false, false, false, 1801) &&
           "a page that never answers releases the quad");
    assert(panel.step(false, false, false, true, 5000));
    assert(!panel.step(false, false, false, false, 4000) && "a clock step back releases it");
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
    storedSettings();
    hostAuthority();
    hostCounter();
    settingsStatus();
    settingsButton();
    workspacePanel();
    pointerEvents();
    hoverEvents();
    assert(FrameMetrics::percentile({3, 1, 4, 2}, .5) == 3);
    assert(FrameMetrics::percentile({3, 1, 4, 2}, 1) == 4);
    assert(FrameMetrics::percentile({}, .99) == 0);
    std::cout << "Native pose, panel-ray, bridge validation and metric tests passed\n";
}
