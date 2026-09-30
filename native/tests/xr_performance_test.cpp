#include "json.hpp"
#include "xr_performance.h"
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using namespace office;
using Json = nlohmann::json;

namespace fake {
struct Counter {
    std::string name;
    XrPerformanceMetricsCounterFlagsANDROID flags;
    XrPerformanceMetricsCounterUnitANDROID unit;
    uint32_t uintValue;
    float floatValue;
};
std::vector<Counter> counters;
std::vector<bool> stateCalls;
std::vector<std::pair<XrPerfSettingsDomainEXT, XrPerfSettingsLevelEXT>> levels;
XrResult enableResult = XR_SUCCESS;
bool loadMetrics = true;
bool runtimeEnabled = false;

void reset() {
    counters.clear();
    stateCalls.clear();
    levels.clear();
    enableResult = XR_SUCCESS;
    loadMetrics = true;
    runtimeEnabled = false;
}
XrPath pathOf(size_t index) { return static_cast<XrPath>(index + 1); }

XRAPI_ATTR XrResult XRAPI_CALL setLevel(XrSession, XrPerfSettingsDomainEXT domain,
                                        XrPerfSettingsLevelEXT level) {
    levels.push_back({domain, level});
    return XR_SUCCESS;
}
XRAPI_ATTR XrResult XRAPI_CALL enumeratePaths(XrInstance, uint32_t capacity, uint32_t *count,
                                              XrPath *paths) {
    *count = static_cast<uint32_t>(counters.size());
    if (!capacity)
        return XR_SUCCESS;
    if (capacity < counters.size())
        return XR_ERROR_SIZE_INSUFFICIENT;
    for (size_t i = 0; i < counters.size(); i++)
        paths[i] = pathOf(i);
    return XR_SUCCESS;
}
XRAPI_ATTR XrResult XRAPI_CALL setState(XrSession, const XrPerformanceMetricsStateANDROID *state) {
    assert(state->type == XR_TYPE_PERFORMANCE_METRICS_STATE_ANDROID);
    stateCalls.push_back(state->enabled == XR_TRUE);
    if (state->enabled && XR_FAILED(enableResult))
        return enableResult;
    runtimeEnabled = state->enabled == XR_TRUE;
    return XR_SUCCESS;
}
XRAPI_ATTR XrResult XRAPI_CALL query(XrSession, XrPath path,
                                     XrPerformanceMetricsCounterANDROID *counter) {
    assert(counter->type == XR_TYPE_PERFORMANCE_METRICS_COUNTER_ANDROID);
    if (!runtimeEnabled)
        return XR_ERROR_VALIDATION_FAILURE;
    if (path == XR_NULL_PATH || path > counters.size())
        return XR_ERROR_PATH_UNSUPPORTED;
    const auto &c = counters[path - 1];
    counter->counterFlags = c.flags;
    counter->counterUnit = c.unit;
    counter->uintValue = c.uintValue;
    counter->floatValue = c.floatValue;
    return XR_SUCCESS;
}
} // namespace fake

extern "C" XRAPI_ATTR XrResult XRAPI_CALL xrGetInstanceProcAddr(XrInstance, const char *name,
                                                                PFN_xrVoidFunction *function) {
    *function = nullptr;
    if (!strcmp(name, "xrPerfSettingsSetPerformanceLevelEXT"))
        *function = reinterpret_cast<PFN_xrVoidFunction>(fake::setLevel);
    else if (fake::loadMetrics && !strcmp(name, "xrEnumeratePerformanceMetricsCounterPathsANDROID"))
        *function = reinterpret_cast<PFN_xrVoidFunction>(fake::enumeratePaths);
    else if (fake::loadMetrics && !strcmp(name, "xrSetPerformanceMetricsStateANDROID"))
        *function = reinterpret_cast<PFN_xrVoidFunction>(fake::setState);
    else if (fake::loadMetrics && !strcmp(name, "xrQueryPerformanceMetricsCounterANDROID"))
        *function = reinterpret_cast<PFN_xrVoidFunction>(fake::query);
    return *function ? XR_SUCCESS : XR_ERROR_FUNCTION_UNSUPPORTED;
}

extern "C" XRAPI_ATTR XrResult XRAPI_CALL xrPathToString(XrInstance, XrPath path, uint32_t capacity,
                                                         uint32_t *count, char *buffer) {
    if (path == XR_NULL_PATH || path > fake::counters.size())
        return XR_ERROR_PATH_INVALID;
    const auto &name = fake::counters[path - 1].name;
    *count = static_cast<uint32_t>(name.size() + 1);
    if (capacity < *count)
        return XR_ERROR_SIZE_INSUFFICIENT;
    memcpy(buffer, name.c_str(), *count);
    return XR_SUCCESS;
}

namespace {
constexpr auto FloatValid = XR_PERFORMANCE_METRICS_COUNTER_ANY_VALUE_VALID_BIT_ANDROID |
                            XR_PERFORMANCE_METRICS_COUNTER_FLOAT_VALUE_VALID_BIT_ANDROID;
constexpr auto UintValid = XR_PERFORMANCE_METRICS_COUNTER_ANY_VALUE_VALID_BIT_ANDROID |
                           XR_PERFORMANCE_METRICS_COUNTER_UINT_VALUE_VALID_BIT_ANDROID;
const auto Instance = reinterpret_cast<XrInstance>(1);
const auto Session = reinterpret_cast<XrSession>(2);

void validity() {
    fake::reset();
    float nan = std::numeric_limits<float>::quiet_NaN();
    fake::counters = {
        {"/perfmetrics_android/gpu/frametime", FloatValid,
         XR_PERFORMANCE_METRICS_COUNTER_UNIT_MILLISECONDS_ANDROID, 99, 7.25f},
        {"/perfmetrics_android/compositor/dropped_frame_count", UintValid,
         XR_PERFORMANCE_METRICS_COUNTER_UNIT_GENERIC_ANDROID, 3, nan},
        {"/nan_only", FloatValid, XR_PERFORMANCE_METRICS_COUNTER_UNIT_PERCENTAGE_ANDROID, 0, nan},
        {"/no_flags", 0, XR_PERFORMANCE_METRICS_COUNTER_UNIT_HERTZ_ANDROID, 5, 5},
        {"/both", FloatValid | UintValid, XR_PERFORMANCE_METRICS_COUNTER_UNIT_HERTZ_ANDROID, 90,
         90.5f},
        {"/nan_with_uint", FloatValid | UintValid,
         XR_PERFORMANCE_METRICS_COUNTER_UNIT_BYTES_ANDROID, 4096, nan},
    };
    {
        RuntimePerformance performance(Instance, Session, true, true);
        assert(performance.sampleJson() == "{}");
        performance.start();
        assert(fake::levels.size() == 2);
        assert(fake::levels[0].first == XR_PERF_SETTINGS_DOMAIN_CPU_EXT);
        assert(fake::levels[1].first == XR_PERF_SETTINGS_DOMAIN_GPU_EXT);
        for (auto level : fake::levels)
            assert(level.second == XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT);
        auto json = Json::parse(performance.sampleJson());
        assert(json.size() == 4);
        assert(json["/perfmetrics_android/gpu/frametime"]["value"] == 7.25);
        assert(json["/perfmetrics_android/gpu/frametime"]["unit"] == "ms");
        auto &dropped = json["/perfmetrics_android/compositor/dropped_frame_count"];
        assert(dropped["value"].is_number_unsigned() && dropped["value"] == 3);
        assert(dropped["unit"] == "generic");
        assert(!json.contains("/nan_only") && !json.contains("/no_flags"));
        assert(json["/both"]["value"] == 90.5 && json["/both"]["unit"] == "hz");
        assert(json["/nan_with_uint"]["value"] == 4096);
        assert(json["/nan_with_uint"]["unit"] == "bytes");
    }
    assert((fake::stateCalls == std::vector<bool>{true, false}));
}

void resume() {
    fake::reset();
    fake::counters = {{"/a", UintValid, XR_PERFORMANCE_METRICS_COUNTER_UNIT_GENERIC_ANDROID, 1, 0}};
    {
        RuntimePerformance performance(Instance, Session, true, false);
        performance.start();
        assert(Json::parse(performance.sampleJson()).size() == 1);
        fake::runtimeEnabled = false;
        assert(performance.sampleJson() == "{}");
        performance.start();
        assert(Json::parse(performance.sampleJson()).size() == 1);
        assert(fake::levels.empty());
    }
    assert((fake::stateCalls == std::vector<bool>{true, true, false}));
}

void failures() {
    fake::reset();
    fake::counters = {{"/a", UintValid, XR_PERFORMANCE_METRICS_COUNTER_UNIT_GENERIC_ANDROID, 1, 0}};
    fake::enableResult = XR_ERROR_RUNTIME_FAILURE;
    {
        RuntimePerformance performance(Instance, Session, true, true);
        performance.start();
        assert(performance.sampleJson() == "{}");
    }
    assert((fake::stateCalls == std::vector<bool>{true}));

    fake::reset();
    fake::loadMetrics = false;
    {
        RuntimePerformance performance(Instance, Session, true, false);
        performance.start();
        assert(performance.sampleJson() == "{}");
    }
    assert(fake::stateCalls.empty());

    fake::reset();
    {
        RuntimePerformance performance(Instance, Session, false, false);
        performance.start();
        assert(performance.sampleJson() == "{}");
    }
    assert(fake::stateCalls.empty() && fake::levels.empty());
}

void bounded() {
    fake::reset();
    for (int i = 0; i < 300; i++)
        fake::counters.push_back({"/c/" + std::to_string(i), UintValid,
                                  XR_PERFORMANCE_METRICS_COUNTER_UNIT_GENERIC_ANDROID,
                                  static_cast<uint32_t>(i), 0});
    RuntimePerformance performance(Instance, Session, true, false);
    performance.start();
    auto json = Json::parse(performance.sampleJson());
    assert(json.size() == RuntimePerformance::MaxCounters);
    assert(json.contains("/c/255") && !json.contains("/c/256"));
    assert(std::string(performanceUnitName(
               static_cast<XrPerformanceMetricsCounterUnitANDROID>(42))) == "unknown");
}
} // namespace

int main() {
    validity();
    resume();
    failures();
    bounded();
    std::cout << "xr_performance tests passed\n";
}
