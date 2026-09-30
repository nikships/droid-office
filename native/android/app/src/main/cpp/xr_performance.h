#pragma once
#include <openxr/openxr.h>
#include <string>
#include <vector>

namespace office {
/**
 * Runtime-reported frame, GPU and compositor counters (XR_ANDROID_performance_metrics) and
 * sustained CPU/GPU level hints (XR_EXT_performance_settings). Neither the instance nor the
 * session is owned; destroy this object before xrDestroySession.
 */
class RuntimePerformance {
  public:
    static constexpr uint32_t MaxCounters = 256;

    RuntimePerformance(XrInstance instance, XrSession session, bool metricsEnabled,
                       bool hintsEnabled);
    ~RuntimePerformance();
    RuntimePerformance(const RuntimePerformance &) = delete;
    RuntimePerformance &operator=(const RuntimePerformance &) = delete;

    /** Call after every successful xrBeginSession. */
    void start();
    /** {"<counter path>":{"value":n,"unit":"ms"},...}; "{}" when nothing valid is available. */
    std::string sampleJson();

  private:
    struct Counter {
        XrPath path;
        std::string name;
    };
    void applyHints();
    bool enableMetrics();
    void enumerateCounters();

    XrInstance instance;
    XrSession session;
    PFN_xrPerfSettingsSetPerformanceLevelEXT setLevel = nullptr;
    PFN_xrEnumeratePerformanceMetricsCounterPathsANDROID enumeratePaths = nullptr;
    PFN_xrSetPerformanceMetricsStateANDROID setState = nullptr;
    PFN_xrQueryPerformanceMetricsCounterANDROID query = nullptr;
    bool metricsOn = false, everEnabled = false, enumerated = false;
    std::vector<Counter> counters;
};

const char *performanceUnitName(XrPerformanceMetricsCounterUnitANDROID unit);
} // namespace office
