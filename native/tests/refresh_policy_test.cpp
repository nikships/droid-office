#include "refresh_policy.h"
#include <cassert>
#include <cstdio>
#include <limits>
int main() {
    office::RefreshPolicy p;
    assert(!p.shouldRequest(0, 90, true));
    assert(p.shouldRequest(100, 72, true));
    assert(!p.shouldRequest(1099, 72, true));
    assert(p.shouldRequest(1100, 72, true));
    assert(!p.shouldRequest(3099, 72, true));
    assert(p.shouldRequest(3100, 72, true));
    assert(!p.shouldRequest(6000, 90, true));
    assert(p.shouldRequest(6001, 72, true));
    assert(!p.shouldRequest(6200, 72, false));
    assert(p.shouldRequest(6201, 72, true));
    assert(!p.shouldRequest(6300, std::numeric_limits<float>::quiet_NaN(), true));
    assert(!p.shouldRequest(6400, 0, true));
    p.reset();
    double now = 0;
    for (int i = 0; i < 12; i++) {
        assert(p.shouldRequest(now, 60, true));
        assert(!p.shouldRequest(now + 1, 60, true));
        now += 30000;
    }
    std::puts("90 Hz preference, bounded retry, recovery and focus tests passed");
}
