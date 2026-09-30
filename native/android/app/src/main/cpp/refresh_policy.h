#pragma once
#include <algorithm>
#include <cmath>

namespace office {
/** Persistent 90 Hz preference with bounded retries; the runtime retains final authority. */
class RefreshPolicy {
  public:
    bool shouldRequest(double nowMs, float actual, bool focused) {
        if (!focused || !std::isfinite(nowMs) || !std::isfinite(actual) || actual <= 0) {
            reset();
            return false;
        }
        if (std::abs(actual - 90.f) < .1f) {
            reset();
            return false;
        }
        if (nowMs < nextRequest)
            return false;
        nextRequest = nowMs + retryDelay;
        retryDelay = std::min(30000.0, retryDelay * 2);
        return true;
    }
    void reset() {
        nextRequest = 0;
        retryDelay = 1000;
    }

  private:
    double nextRequest = 0, retryDelay = 1000;
};
} // namespace office
