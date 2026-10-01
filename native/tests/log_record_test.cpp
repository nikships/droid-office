#include "log_record.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <string>
using office::fitLogJson;
using office::kLogMessageBytes;
using office::logJsonBudget;

namespace {
// The keys harness/metrics.sh reads from FRAME_METRICS.
const char *const kHarnessKeys[] = {"fps",
                                    "missedPeriods",
                                    "cpuP50Ms",
                                    "cpuP99Ms",
                                    "intervalP99Ms",
                                    "seconds",
                                    "worldWidth",
                                    "worldHeight",
                                    "worldRecommendedWidth",
                                    "worldMaxWidth",
                                    "worldRecommendedHeight",
                                    "worldMaxHeight",
                                    "gaze",
                                    "foveationEnabled",
                                    "foveationSupported",
                                    "sharpSetting",
                                    "sharpScreens",
                                    "refresh",
                                    "refreshRequestedHz",
                                    "focused",
                                    "graphicsError"};

/** The GLES office's FRAME_METRICS keys (office_xr.cpp) with the widest values they can take. */
nlohmann::json glesFrameMetrics(const std::string &graphicsError) {
    auto j = nlohmann::json::parse(
        "{\"fps\":90.123,\"refresh\":90.00,\"periodMs\":11.111,\"focused\":true,\"rendered\":"
        "4294967295,\"skipped\":4294967295,\"missedPeriods\":4294967295,\"cpuP50Ms\":1234.567,"
        "\"cpuP95Ms\":1234.567,\"cpuP99Ms\":1234.567,\"cpuMaxMs\":1234.567,\"intervalP99Ms\":"
        "1234.567,\"seconds\":5.012,\"gaze\":true}");
    j["controlHeartbeats"] = 18446744073709551615ull;
    j["controlAgeMs"] = 59999.123456789012;
    j["refreshRequestedHz"] = 90;
    j["refreshRequests"] = 4294967295u;
    j["sharpScreens"] = true;
    j["sharpSetting"] = true;
    j["worldRecommendedWidth"] = 2147483647;
    j["worldRecommendedHeight"] = 2147483647;
    j["worldMaxWidth"] = 2147483647;
    j["worldMaxHeight"] = 2147483647;
    j["worldWidth"] = 2147483647;
    j["worldHeight"] = 2147483647;
    j["maxRenderScale"] = 1.6982758045196533;
    j["foveationSupported"] = true;
    j["foveationEnabled"] = true;
    j["foveationLevel"] = "medium";
    j["graphicsError"] = graphicsError;
    j["sharpWidth"] = 2147483647;
    j["sharpHeight"] = 2147483647;
    j["sharpCrop"] = {{-2147483647, -2147483647, 2147483647, 2147483647},
                      {-2147483647, -2147483647, 2147483647, 2147483647}};
    return j;
}

void shortRecordUnchanged() {
    const nlohmann::json j = {{"fps", 90.012345678}, {"text", "short"}, {"n", 7}};
    bool fits = false;
    assert(fitLogJson(j, 1000, &fits) == j.dump(-1, ' ', true) && fits);
    assert(logJsonBudget(14) == kLogMessageBytes - 14 && logJsonBudget(5000) == 0);
}

void glesFrameMetricsFit() {
    // The office's own line: "FRAME_METRICS <json> gl_error=<hex>".
    const size_t budget = logJsonBudget(std::strlen("FRAME_METRICS  gl_error=ffffffff"));
    for (const std::string &error :
         {std::string(), std::string("World target allocation failed"), std::string(4000, 'e')}) {
        const auto record = glesFrameMetrics(error);
        bool fits = false;
        const auto text = fitLogJson(record, budget, &fits);
        assert(fits && text.size() <= budget);
        const auto back = nlohmann::json::parse(text);
        for (const char *key : kHarnessKeys)
            assert(back.contains(key));
        // Integers and booleans are never changed.
        assert(back["worldWidth"] == 2147483647 && back["missedPeriods"] == 4294967295u);
        assert(back["controlHeartbeats"] == 18446744073709551615ull && back["gaze"] == true);
        assert(back["sharpCrop"] == record["sharpCrop"]);
        if (error.size() < 100)
            assert(back["graphicsError"] == error);
        else {
            const auto shortened = back["graphicsError"].get<std::string>();
            assert(shortened.size() < error.size());
            assert(shortened.compare(shortened.size() - 3, 3, "...") == 0);
        }
    }
}

void fractionsRoundBeforeStringsShrink() {
    nlohmann::json j = {{"a", 19.206146240234375}, {"b", 0.003333000000566244}, {"c", 3}};
    const auto full = j.dump(-1, ' ', true);
    bool fits = false;
    const auto text = fitLogJson(j, full.size() - 1, &fits);
    assert(fits);
    const auto back = nlohmann::json::parse(text);
    assert(back["a"] == 19.206 && back["b"] == 0.003 && back["c"] == 3);
}

void nestedAndUtf8() {
    // A nested string is found; a cut never splits a UTF-8 sequence (the dump would throw).
    std::string wide;
    for (int i = 0; i < 300; ++i)
        wide += "\xc3\xa9"; // U+00E9
    nlohmann::json j = {{"outer", {{"inner", wide}}}, {"keep", "ok"}};
    for (size_t budget = 40; budget < 200; ++budget) {
        bool fits = false;
        const auto text = fitLogJson(j, budget, &fits);
        assert(fits && text.size() <= budget);
        const auto back = nlohmann::json::parse(text);
        assert(back["keep"] == "ok");
        const auto inner = back["outer"]["inner"].get<std::string>();
        assert(inner.compare(inner.size() - 3, 3, "...") == 0);
    }
}

void cannotFit() {
    // Only integers: nothing may shrink, so the whole text comes back and fits is false.
    nlohmann::json j = nlohmann::json::array();
    for (int i = 0; i < 100; ++i)
        j.push_back(123456789);
    bool fits = true;
    const auto text = fitLogJson(j, 50, &fits);
    assert(!fits && text == j.dump(-1, ' ', true));
}
} // namespace

int main() {
    shortRecordUnchanged();
    glesFrameMetricsFit();
    fractionsRoundBeforeStringsShrink();
    nestedAndUtf8();
    cannotFit();
    std::cout << "log record tests passed\n";
}
