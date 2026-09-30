#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace office {
/** One Android touch stream from the controller triggers, with fresh press edges and
 * cancellation on tracking loss. */
class PanelPointer {
  public:
    struct Sample {
        bool active, panelOpen, holding, hit;
        float trigger, x, y;
    };
    struct Result {
        int action = -1; // Android DOWN, UP, MOVE, CANCEL are 0, 1, 2, 3.
        float x = 0, y = 0;
        bool consumed = false;
    };
    Result step(int index, const Sample &sample) {
        auto &slot = slots[index];
        bool allowed = sample.active && sample.panelOpen && !sample.holding;
        bool down = sample.trigger >= (slot.down ? .6f : .75f);
        Result result;
        if (sample.hit) {
            slot.x = sample.x;
            slot.y = sample.y;
        }
        result.x = slot.x;
        result.y = slot.y;
        if (owner == index) {
            result.consumed = true;
            if (!allowed || (!down && !sample.hit)) {
                result.action = 3;
                owner = -1;
            } else if (!down) {
                result.action = 1;
                owner = -1;
            } else if (sample.hit) {
                result.action = 2;
            }
        } else if (allowed && sample.hit && slot.armed && down && !slot.down && owner < 0) {
            result.action = 0;
            owner = index;
        }
        result.consumed = result.consumed || (allowed && sample.hit);
        if (!sample.active) {
            slot.armed = false;
        } else if (!down) {
            slot.armed = true;
        }
        slot.down = down;
        return result;
    }
    bool pressed() const { return owner >= 0; }

  private:
    struct Slot {
        bool down = false, armed = false;
        float x = 0, y = 0;
    };
    std::array<Slot, 2> slots{};
    int owner = -1;
};

/** One mouse hover stream for the two rays, at most 30 moves/second; it never presses. */
class PanelHover {
  public:
    struct Sample {
        bool hit = false;
        float x = 0, y = 0;
    };
    PanelPointer::Result step(const std::array<Sample, 2> &samples, bool pressed, double time) {
        const bool allowed = !pressed && (samples[0].hit || samples[1].hit);
        if (!allowed) {
            if (owner < 0)
                return {};
            owner = -1;
            return {10, x, y, false}; // Android HOVER_EXIT
        }
        const bool enter = owner < 0;
        if (owner < 0 || !samples[owner].hit)
            owner = samples[1].hit ? 1 : 0;
        const auto &sample = samples[owner];
        if (enter || ((time >= nextMove || time < lastTime) &&
                      (std::abs(sample.x - x) >= 1 || std::abs(sample.y - y) >= 1))) {
            x = sample.x;
            y = sample.y;
            lastTime = time;
            nextMove = time + 1.0 / 30;
            return {enter ? 9 : 7, x, y, false}; // Android HOVER_ENTER / HOVER_MOVE
        }
        return {};
    }

  private:
    int owner = -1;
    float x = 0, y = 0;
    double nextMove = 0, lastTime = 0;
};
} // namespace office
