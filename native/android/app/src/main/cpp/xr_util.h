#pragma once
#include <openxr/openxr.h>

namespace office {
template <class T> T structure(XrStructureType type) {
    T result{};
    result.type = type;
    return result;
}
} // namespace office
