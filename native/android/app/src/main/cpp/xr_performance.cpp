#include "xr_performance.h"
#include "json.hpp"
#include "xr_util.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifdef __ANDROID__
#include <android/log.h>
#define PERF_LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeXR", __VA_ARGS__)
#else
#define PERF_LOG(...) (fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#endif

namespace office {
namespace {
// A runtime reporting thousands of paths is broken; refuse rather than allocate unbounded memory.
constexpr uint32_t MaxEnumeratedPaths = 4096;

template <class Pfn> bool load(XrInstance instance, const char *name, Pfn &out) {
    PFN_xrVoidFunction function = nullptr;
    XrResult result = xrGetInstanceProcAddr(instance, name, &function);
    if (XR_FAILED(result) || !function) {
        PERF_LOG("PERF_LOAD %s result=%d", name, result);
        out = nullptr;
        return false;
    }
    out = reinterpret_cast<Pfn>(function);
    return true;
}

// Float counters print at float precision instead of the widened double's noise digits.
double floatValue(float value) {
    char text[32];
    snprintf(text, sizeof(text), "%.7g", value);
    return strtod(text, nullptr);
}
} // namespace

const char *performanceUnitName(XrPerformanceMetricsCounterUnitANDROID unit) {
    switch (unit) {
    case XR_PERFORMANCE_METRICS_COUNTER_UNIT_GENERIC_ANDROID:
        return "generic";
    case XR_PERFORMANCE_METRICS_COUNTER_UNIT_PERCENTAGE_ANDROID:
        return "percent";
    case XR_PERFORMANCE_METRICS_COUNTER_UNIT_MILLISECONDS_ANDROID:
        return "ms";
    case XR_PERFORMANCE_METRICS_COUNTER_UNIT_BYTES_ANDROID:
        return "bytes";
    case XR_PERFORMANCE_METRICS_COUNTER_UNIT_HERTZ_ANDROID:
        return "hz";
    default:
        return "unknown";
    }
}

RuntimePerformance::RuntimePerformance(XrInstance instance, XrSession session, bool metricsEnabled,
                                       bool hintsEnabled)
    : instance(instance), session(session) {
    if (hintsEnabled)
        load(instance, "xrPerfSettingsSetPerformanceLevelEXT", setLevel);
    if (metricsEnabled &&
        !(load(instance, "xrEnumeratePerformanceMetricsCounterPathsANDROID", enumeratePaths) &&
          load(instance, "xrSetPerformanceMetricsStateANDROID", setState) &&
          load(instance, "xrQueryPerformanceMetricsCounterANDROID", query)))
        enumeratePaths = nullptr, setState = nullptr, query = nullptr;
}

RuntimePerformance::~RuntimePerformance() {
    if (!everEnabled)
        return;
    auto state =
        structure<XrPerformanceMetricsStateANDROID>(XR_TYPE_PERFORMANCE_METRICS_STATE_ANDROID);
    state.enabled = XR_FALSE;
    XrResult result = setState(session, &state);
    PERF_LOG("PERF_METRICS disable result=%d", result);
}

void RuntimePerformance::start() {
    applyHints();
    if (enableMetrics() && !enumerated)
        enumerateCounters();
}

void RuntimePerformance::applyHints() {
    if (!setLevel)
        return;
    for (auto domain : {XR_PERF_SETTINGS_DOMAIN_CPU_EXT, XR_PERF_SETTINGS_DOMAIN_GPU_EXT}) {
        XrResult result = setLevel(session, domain, XR_PERF_SETTINGS_LEVEL_SUSTAINED_HIGH_EXT);
        PERF_LOG("PERF_HINT %s sustained_high result=%d",
                 domain == XR_PERF_SETTINGS_DOMAIN_CPU_EXT ? "cpu" : "gpu", result);
    }
}

bool RuntimePerformance::enableMetrics() {
    if (!setState)
        return false;
    auto state =
        structure<XrPerformanceMetricsStateANDROID>(XR_TYPE_PERFORMANCE_METRICS_STATE_ANDROID);
    state.enabled = XR_TRUE;
    XrResult result = setState(session, &state);
    PERF_LOG("PERF_METRICS enable result=%d", result);
    metricsOn = XR_SUCCEEDED(result);
    everEnabled = everEnabled || metricsOn;
    return metricsOn;
}

void RuntimePerformance::enumerateCounters() {
    enumerated = true;
    uint32_t count = 0;
    XrResult result = enumeratePaths(instance, 0, &count, nullptr);
    if (XR_FAILED(result) || count > MaxEnumeratedPaths) {
        PERF_LOG("PERF_METRICS enumerate result=%d count=%u", result, count);
        return;
    }
    std::vector<XrPath> paths(count, XR_NULL_PATH);
    result = enumeratePaths(instance, count, &count, paths.data());
    if (XR_FAILED(result)) {
        PERF_LOG("PERF_METRICS enumerate result=%d", result);
        return;
    }
    paths.resize(std::min<uint32_t>(count, paths.size()));
    if (paths.size() > MaxCounters)
        PERF_LOG("PERF_METRICS keeping %u of %zu counters", MaxCounters, paths.size());
    for (XrPath path : paths) {
        if (counters.size() >= MaxCounters)
            break;
        char name[XR_MAX_PATH_LENGTH] = {};
        uint32_t length = 0;
        result = xrPathToString(instance, path, sizeof(name), &length, name);
        if (XR_FAILED(result) || !length) {
            PERF_LOG("PERF_METRICS path %llu name result=%d", static_cast<unsigned long long>(path),
                     result);
            continue;
        }
        name[sizeof(name) - 1] = 0;
        counters.push_back({path, name});
    }
    PERF_LOG("PERF_METRICS counters=%zu", counters.size());
    for (const auto &counter : counters) {
        auto sample = structure<XrPerformanceMetricsCounterANDROID>(
            XR_TYPE_PERFORMANCE_METRICS_COUNTER_ANDROID);
        result = query(session, counter.path, &sample);
        PERF_LOG("PERF_COUNTER %s unit=%s flags=%llx result=%d", counter.name.c_str(),
                 XR_SUCCEEDED(result) ? performanceUnitName(sample.counterUnit) : "?",
                 static_cast<unsigned long long>(sample.counterFlags), result);
    }
}

std::string RuntimePerformance::sampleJson() {
    if (!metricsOn || counters.empty())
        return "{}";
    try {
        nlohmann::json out = nlohmann::json::object();
        for (const auto &counter : counters) {
            auto sample = structure<XrPerformanceMetricsCounterANDROID>(
                XR_TYPE_PERFORMANCE_METRICS_COUNTER_ANDROID);
            if (XR_FAILED(query(session, counter.path, &sample)))
                continue;
            nlohmann::json value;
            if ((sample.counterFlags &
                 XR_PERFORMANCE_METRICS_COUNTER_FLOAT_VALUE_VALID_BIT_ANDROID) &&
                std::isfinite(sample.floatValue))
                value = floatValue(sample.floatValue);
            else if (sample.counterFlags &
                     XR_PERFORMANCE_METRICS_COUNTER_UINT_VALUE_VALID_BIT_ANDROID)
                value = sample.uintValue;
            else
                continue;
            out[counter.name] = {{"value", value},
                                 {"unit", performanceUnitName(sample.counterUnit)}};
        }
        return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    } catch (...) {
        return "{}";
    }
}
} // namespace office
