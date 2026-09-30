#pragma once
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace office {
/** A focused, submitted frame is counted separately from an idle or invisible session. */
class FrameMetrics {
  public:
    using Clock = std::chrono::steady_clock;
    void reset() {
        started = Clock::now();
        lastSubmit = {};
        lastPredicted = 0;
        cpu.clear();
        intervals.clear();
        skipped = 0;
        missed = 0;
    }
    void submit(bool rendered, bool focused, int64_t predicted, int64_t period, double cpuMs) {
        auto now = Clock::now();
        if (!focused) {
            reset();
            return;
        }
        if (!rendered) {
            skipped++;
            return;
        }
        if (lastSubmit.time_since_epoch().count())
            intervals.push_back(
                std::chrono::duration<double, std::milli>(now - lastSubmit).count());
        if (lastPredicted && period > 0) {
            auto elapsed = predicted - lastPredicted;
            if (elapsed > period * 3 / 2)
                missed +=
                    std::max<int64_t>(0, std::llround(static_cast<double>(elapsed) / period) - 1);
        }
        lastSubmit = now;
        lastPredicted = predicted;
        cpu.push_back(cpuMs);
    }
    double seconds() const { return std::chrono::duration<double>(Clock::now() - started).count(); }
    bool ready() const { return seconds() >= 5 && !cpu.empty(); }
    std::string json(float refresh, float periodMs, bool gaze) const {
        double elapsed = seconds();
        char buffer[1024];
        snprintf(
            buffer, sizeof(buffer),
            "{\"fps\":%.3f,\"refresh\":%.2f,\"periodMs\":%.3f,\"focused\":true,\"rendered\":%zu,"
            "\"skipped\":%u,\"missedPeriods\":%u,\"cpuP50Ms\":%.3f,\"cpuP95Ms\":%.3f,\"cpuP99Ms\":%"
            ".3f,\"cpuMaxMs\":%.3f,\"intervalP99Ms\":%.3f,\"seconds\":%.3f,\"gaze\":%s}",
            cpu.size() / elapsed, refresh, periodMs, cpu.size(), skipped, missed,
            percentile(cpu, .5), percentile(cpu, .95), percentile(cpu, .99), percentile(cpu, 1),
            percentile(intervals, .99), elapsed, gaze ? "true" : "false");
        return buffer;
    }
    static double percentile(std::vector<double> values, double quantile) {
        if (values.empty())
            return 0;
        auto index =
            static_cast<size_t>(std::ceil(std::clamp(quantile, 0., 1.) * (values.size() - 1)));
        std::nth_element(values.begin(), values.begin() + index, values.end());
        return values[index];
    }

  private:
    Clock::time_point started = Clock::now(), lastSubmit{};
    int64_t lastPredicted = 0;
    std::vector<double> cpu, intervals;
    unsigned skipped = 0, missed = 0;
};
} // namespace office
