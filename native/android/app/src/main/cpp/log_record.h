// JSON metrics lines that fit one Android log record. __android_log_print formats its message
// into a buffer of LOG_BUF_SIZE (1024) bytes and drops the rest (liblog, logger_write.cpp), so a
// longer FRAME_METRICS line reaches logcat cut at 1023 bytes, as invalid JSON that
// harness/metrics.sh skips. Header-only and Android-free: native/tests/log_record_test.cpp runs it.
#pragma once
#include "json.hpp"

#include <cmath>
#include <cstddef>
#include <string>

namespace office {

/** Bytes one __android_log_print message keeps: LOG_BUF_SIZE less its terminating NUL. */
constexpr size_t kLogMessageBytes = 1023;

/** What is left of one log message for a JSON text after `reserved` bytes of other text. */
constexpr size_t logJsonBudget(size_t reserved) {
    return reserved < kLogMessageBytes ? kLogMessageBytes - reserved : 0;
}

namespace detail {
/** The longest string value anywhere in `value` (object members and array elements). */
inline nlohmann::json *longestString(nlohmann::json &value, size_t &length) {
    nlohmann::json *found = nullptr;
    if (value.is_string()) {
        const size_t size = value.get_ref<const std::string &>().size();
        if (size > length) {
            length = size;
            found = &value;
        }
        return found;
    }
    if (value.is_object() || value.is_array())
        for (auto &child : value) {
            size_t childLength = length;
            if (auto *longer = longestString(child, childLength)) {
                length = childLength;
                found = longer;
            }
        }
    return found;
}

/** Rounds every floating-point number in `value` to three decimals. */
inline void roundFractions(nlohmann::json &value) {
    if (value.is_number_float()) {
        const double v = value.get<double>();
        if (std::isfinite(v))
            value = std::round(v * 1000.0) / 1000.0;
        return;
    }
    if (value.is_object() || value.is_array())
        for (auto &child : value)
            roundFractions(child);
}
} // namespace detail

/**
 * The compact JSON text of `record` (as dump(-1, ' ', true)) in at most `budget` bytes. Only a
 * longer text changes: its floating-point numbers are rounded to three decimals, then its longest
 * string values are shortened, each ending in "...", until it fits. Keys, integers and booleans
 * never change, so every key a reader looks up stays. `fits` (optional) is false when nothing can
 * shrink further; the text is then returned as short as it got.
 */
inline std::string fitLogJson(nlohmann::json record, size_t budget, bool *fits = nullptr) {
    static const std::string ellipsis = "...";
    std::string text = record.dump(-1, ' ', true);
    if (text.size() > budget) {
        detail::roundFractions(record);
        text = record.dump(-1, ' ', true);
    }
    while (text.size() > budget) {
        size_t length = ellipsis.size();
        nlohmann::json *longest = detail::longestString(record, length);
        if (!longest) {
            if (fits)
                *fits = false;
            return text;
        }
        std::string &value = longest->get_ref<std::string &>();
        // Escapes make the text at least as long as the string, so cutting the excess from the
        // string shortens the text by at least as much; the loop measures again regardless.
        const size_t excess = text.size() - budget + ellipsis.size();
        size_t keep = value.size() > excess ? value.size() - excess : 0;
        // Never inside a UTF-8 sequence: back off to the first byte of the character at `keep`.
        while (keep > 0 && (static_cast<unsigned char>(value[keep]) & 0xC0) == 0x80)
            --keep;
        value = value.substr(0, keep) + ellipsis;
        text = record.dump(-1, ' ', true);
    }
    if (fits)
        *fits = true;
    return text;
}

} // namespace office
